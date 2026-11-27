# Integrar con Gentle Shell

La integración nativa se preparó sobre `Gentleman-Programming/gentle-shell` en el commit `c9b59ea`.

1. Copia `lib/gentle-graph/`, `extensions/gentle-graph.ts`, `skills/gentle-graph/`, `scripts/audit-gentle-graph.mjs` y `tests/gentle-graph.test.ts` a las mismas rutas del clon de Gentle Shell. El host proporciona Pi, TypeBox y `lib/append-system-prompt.ts`.
2. En el proyecto que analizarán los agentes, incorpora las entradas de `.pi/gentle-ai/tools.json` a la configuración existente. Para varios proyectos, puedes instalar el mismo archivo como `<configHome>/agent-overlays.d/gentle-graph.json`. La configuración del proyecto tiene prioridad.
3. Añade `.gentle-graph/index.json` al archivo `.gitignore` del proyecto analizado.
4. Desde la raíz del host ejecuta `pnpm typecheck`, `pnpm run check:runtime-modules` y `pnpm test`. Reinicia la sesión para cargar la extensión.

## Herramientas por agente

| Agente | Herramientas añadidas |
| --- | --- |
| explore, jd-fix-agent | graph_guide, graph_inspect, graph_impact |
| worker | graph_guide, graph_inspect, graph_impact, graph_register_pattern |
| verify, jd-judge-a, jd-judge-b | graph_inspect, graph_impact |

La extensión selecciona la primera raíz disponible en este orden: parámetro `projectRoot`, directorio de la sesión, variable `GENTLE_WORKTREE_ROOT` y directorio del proceso.

## Verificar una sesión

Despacha una tarea de exploración que requiera localizar un símbolo y sus dependientes. Comprueba las llamadas del subagente en su transcripción. Para resumir la disponibilidad registrada y el uso por sesión, pasa el directorio que contiene los archivos JSONL al auditor.

```sh
node scripts/audit-gentle-graph.mjs gentle-agents/sessions
```

La auditoría cuenta las llamadas observadas. Para medir reducción de duplicados se necesita comparar cambios de código entre tareas equivalentes.

## Comparación reproducible con y sin grafo

Ejecuta desde la copia instalada de Gentle Graph. Necesitas Git, Pi con el mismo modelo autenticado para ambas variantes y un comando de verificación que funcione en un worktree limpio. El tercer argumento identifica el proveedor y el modelo. En Windows puedes definir PI_CLI_JS con la ruta absoluta al archivo JavaScript de entrada de Pi. El directorio de salida debe ser nuevo.

```sh
node scripts/compare-graph.mjs . tarea.txt proveedor/modelo resultados node --test tests/gentle-graph.test.ts
```

Ejemplo de tarea para ambas variantes: «Localiza la lógica que reconoce pruebas de Python. Añade una regresión para tests anidados, reutiliza el adaptador existente y explica qué comportamiento verificaste». Coloca ese texto en tarea.txt. Las variantes parten del mismo commit, en orden aleatorio y con sesiones nuevas. El tiempo incluye el proceso del agente y excluye la verificación posterior. Los tokens proceden de usage.totalTokens de Pi, incluido el contexto en caché que registre el proveedor. Cada salida conserva la sesión, el parche y el resultado de verificación. Revisa los parches sin ver la etiqueta de la variante. Registra calidad (0 = incorrecto, 1 = parcial, 2 = cumple), símbolos existentes reutilizados y bloques de lógica duplicada frente al commit base. Los valores sin revisar quedan en null. Repite por pares antes de estimar un ahorro.

## Validación de roles en dos worktrees

Crea dos worktrees del mismo commit y añade en cada uno un archivo TypeScript de nombre distinto, p. ej. probeAlpha.ts y probeBeta.ts, con una función exportada de nombre probeAlpha o probeBeta respectivamente. En cada worktree abre Gentle Shell y despacha explore, worker, verify, jd-fix-agent, jd-judge-a y jd-judge-b. Inicia cada pareja del mismo rol en paralelo. Indícales «Invoca graph_inspect sobre probeAlpha [o probeBeta] sin pasar projectRoot y devuelve su archivo». Conserva las transcripciones individuales de Pi de cada proceso hijo y asócialas al rol que muestra el despachador.

Pasa a `node scripts/verify-graph-roles.mjs matriz.json` un array JSON con dos entradas. Cada entrada contiene root (ruta absoluta del worktree), symbol, marker (por ejemplo probeAlpha.ts) y sessions (objeto cuyas seis claves son los roles y cuyos valores son rutas a los JSONL). El verificador exige doce sesiones distintas, solapamiento por pareja, directorio correcto y una llamada con respuesta que contenga el marcador local.

## Rendimiento y persistencia

`node scripts/bench-jit.mjs 30000 7 --check` prepara una vez el fixture y lanza siete procesos nuevos sin caché del grafo. Emite muestras, mediana y p95 de la primera guía, del detector de arquitectura y del parseo Python. El sistema operativo puede conservar su caché de disco. Los umbrales de p95 son 150 ms, 15 ms y 2 ms/archivo respectivamente. El benchmark Python usa un módulo pequeño y mide sólo el parser.

Con más de 2000 archivos efectivamente indexados se activa SQLite WAL de Node. El índice regenerable vuelve a JSON si falla SQLite. La guía sigue siendo JSON legible. Las escrituras programáticas de la guía usan una transacción de bloqueo por worktree. Añade `.gentle-graph/*.sqlite*`, `.gentle-graph/profile.json` y `.gentle-graph/index.json` al gitignore de cada proyecto.


## Tercera variante con CodeGraph

Define `CODEGRAPH_PI_EXTENSION` con la ruta absoluta a la extensión Pi de CodeGraph instalada y ejecuta el mismo comparador. En PowerShell usa `$env:CODEGRAPH_PI_EXTENSION = 'C:\ruta\codegraph-extension.ts'`. Si requiere preparar su índice, define `CODEGRAPH_PREPARE_ARGV` como un array JSON con el ejecutable y sus argumentos, según tu instalación. Se ejecuta en el worktree de CodeGraph y su tiempo se registra por separado. El comparador aleatoriza las tres variantes, registra las herramientas activas antes del turno y devuelve error si CodeGraph no añadió herramientas frente al control. Configura el backend para que lea el worktree actual. Archiva la versión de la extensión, CLI y modelo junto al informe. El benchmark requiere una instalación operativa de CodeGraph para producir resultados de esa variante.

### Benchmark A/B/C en Windows

Desde el checkout de Gentle Graph que contiene el lanzador, usa PowerShell:

```powershell
node scripts/bench-gentle-shell.mjs --abc "D:\Dev\Gentleman\gentle-shell"
```

El lanzador usa la copia instalada de Pi y TypeScript 5.9.3 en el `node_modules` de Gentle Shell. Necesita Node 24, Git, el login de Pi para `openai-codex/gpt-6.2-sol` y un `codegraph --version` operativo. Los dos clones deben contener los commits `efeed94` (motor) y `c9b59ea` (host). El checkout que contiene el lanzador puede estar en una revisión posterior.

Para B se utiliza únicamente la entrada de servidor stdio `mcpServers.codegraph` del `mcp.json` de Pi. Si tu configuración funcional está en otro archivo, define `$env:GENTLE_ABC_MCP_CONFIG` con su ruta. El lanzador fija `exposure: "direct"` y el directorio de trabajo del servidor al worktree de B. Usa `{worktree}` en argumentos que requieran una ruta de repositorio explícita. Para indexar antes de la sesión, se admite `CODEGRAPH_PREPARE_ARGV` con un array JSON de ejecutable y argumentos. Usa el ejecutable nativo o Node con la ruta del script para preparar en Windows.

Se crean nueve worktrees y nueve hogares de Pi. Todos cargan el paquete Gentle Shell fijado; B añade el servidor MCP y C la extensión del motor fijado. Antes del primer prompt se comprueban tipos, modelo y herramientas en los nueve entornos mediante RPC. Para ejecutar únicamente estas comprobaciones, añade `--preflight-only`. Cada invocación genera una carpeta distinta dentro de `Documentos\Gentle-Graph\benchmarks\abc-efeed94-c9b59ea`.

Se ejecuta la tarea original con razonamiento `high` en orden ABC, BCA y CAB. Las verificaciones del parche ejecutan el `verify.mjs` fijado y el compilador por separado. Los fallos de un brazo se registran y la ronda siguiente continúa. El proceso sale con código 1 si alguna corrida es inválida. El consolidado incluye solo rondas con tres brazos válidos. El primer edit se mide desde el inicio del proceso del agente hasta el evento real de ejecución. Las llamadas anidadas se cuentan a partir de eventos de Pi con ID de padre. Una edición ausente conserva el valor N/D.

`summary.json` e `informe-abc.md` se escriben junto a los directorios por brazo con verificaciones, transcripciones, eventos y parches. La preparación de CodeGraph queda fuera del tiempo del agente y se registra por separado.
