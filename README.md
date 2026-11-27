<p align="center"><img src="assets/gentle-graph.png" width="640" alt="Gentle Graph"></p>

# Gentle Graph

Grafo de código nativo para Gentle Shell que ayuda a los agentes a reutilizar módulos, evaluar el impacto de un cambio y encontrar pruebas relacionadas en cada worktree.

Antes de crear otro helper, el agente puede buscar una pieza existente. Antes de cambiar su firma, puede inspeccionar quién la llama y qué pruebas conviene ejecutar. El índice se actualiza al consultar el proyecto, sin servidor MCP ni sincronización manual.

| Herramienta | Pregunta que responde |
| --- | --- |
| `graph_guide` | ¿Qué módulos, patrones y contratos puedo reutilizar para esta tarea? |
| `graph_inspect` | ¿Dónde está este símbolo, a qué llama y quién lo invoca? |
| `graph_impact` | ¿Qué archivos y pruebas conviene revisar si lo cambio? |
| `graph_register_pattern` | ¿Cómo dejo registrada una decisión de reutilización para futuras sesiones? |

## Probar el motor

Desde la raíz del clon, con Node.js 24, puedes ejecutar las pruebas y consultar el propio repositorio sin instalar paquetes.

```sh
node --test tests/gentle-graph.test.ts
node --input-type=module -e "import { graphInspect } from './lib/gentle-graph/index.ts'; console.log(graphInspect('syncGraphIndex'))"
```

Cada worktree conserva su índice en `.gentle-graph/index.json` y pasa a SQLite WAL cuando supera 2000 archivos indexados. SQLite usa un esquema relacional v2, WAL y búsqueda FTS5 por ruta, etiquetas y símbolos. Si la base ya existe, se reutiliza también en proyectos pequeños. Para NFS o recursos SMB montados, configura `GENTLE_GRAPH_STORE=json`; las rutas UNC usan JSON automáticamente. La migración del índice SQLite anterior es transaccional. Los patrones compartidos viven en `.gentle-graph/guide.json`, que puedes versionar. Las relaciones entre símbolos y las pruebas sugeridas son heurísticas. Conviene revisar los resultados cuando haya símbolos homónimos o llamadas dinámicas.

[Integrar con Gentle Shell y configurar subagentes](docs/gentle-graph-integration.md)

## Rendimiento

La extensión carga el índice en la primera consulta. Durante dos segundos, las consultas del mismo worktree pueden reutilizar el inventario y las respuestas completas. Una ruta nueva o una edición en un archivo previamente limpio puede tardar hasta esa ventana en aparecer. Al vencer esa ventana, el motor compara las fechas de modificación y calcula SHA-256 para los archivos que cambiaron. Omite archivos mayores de 256 KiB y fuentes con sufijos como `.min.js` y `.bundle.js`.

Los mapas en memoria permiten buscar directamente un símbolo por nombre o identificador y recuperar sus llamadores por nombre. El tiempo de recorrer dependencias y de preparar recomendaciones depende del número de resultados. La respuesta de la extensión tiene un máximo de 1199 caracteres para guía sin fragmentos, 3000 para inspección y 2000 para impacto.

### Indexado progresivo en monorepos

En un worktree Git con más de 500 rutas de código, la guía selecciona hasta 15 candidatos por intención y sigue sus imports relativos un salto. Las rutas modificadas y los patrones registrados se revisan aunque queden fuera de esos candidatos. Una guía en frío usa el parser ligero, y las consultas de referencias afinan las entradas con el parser habitual. En repos pequeños y directorios sin Git se conserva la sincronización completa. Si Git falla durante una consulta en un repositorio, se puede reintentar.

Para módulos TS/JS, el impacto sigue imports y reexportaciones relativos y usa las declaraciones para localizar los llamadores. En otros lenguajes puede ampliar la búsqueda por nombre. Si se agota el presupuesto de 1500 ms, la salida indica que el impacto es parcial. Las referencias dinámicas y los nombres ambiguos conservan las limitaciones del parser.

Para medir una guía en frío en tu máquina:

```sh
node scripts/bench-jit.mjs 5000
node scripts/bench-jit.mjs 30000
```

El cronómetro incluye la consulta, el descubrimiento de rutas y la escritura del índice. La creación del repositorio de prueba y el arranque de Node quedan fuera. Para validar cambios, ejecuta `pnpm test`. El chequeo `pnpm typecheck` usa el compilador TypeScript, tipos de Node, Pi y TypeBox del entorno de desarrollo de Gentle Shell.

### Lenguajes, WPF y guía arquitectónica

La opción `includeSnippets: true` de `graph_guide` añade hasta tres símbolos de los módulos recomendados con código, llamadores, llamadas e implementaciones explícitas. La respuesta ampliada usa hasta 3000 caracteres. La guía habitual contiene hasta 1199 caracteres. Las referencias dependen de las declaraciones que reconoce el adaptador.

| Ecosistema | Evidencia que puede encontrar |
| --- | --- |
| Java y PHP | Clases, métodos, interfaces, herencia e implementaciones. Señales de Spring Boot, Laravel y Symfony. |
| Ruby | Clases, módulos, métodos, herencia y mixins. Rails en Gemfile. |
| SvelteKit | Componentes importados, uso en el template, rutas y alias estándar `$lib`. |
| C y C++ | Includes locales, funciones, métodos calificados y bases de clases. |
| Kotlin y Swift | Interfaces y protocolos, clases, actores y extensiones. Señales de Android MVVM, Ktor y SwiftUI. |
| Dart y Flutter | Clases, mixins y referencias declaradas en pubspec.yaml a Flutter, BLoC y Riverpod. |


El índice reconoce TS/JS, Python, Go, Rust, C# y XAML. Puedes consultar métodos por nombre cualificado, como `Store.Get` o `Client::fetch`. En WPF, prueba `graph_impact("SaveOrderAsync")` para seguir el comando generado por el Toolkit hasta la vista que lo enlaza. Las dependencias por interfaz indican consumidores potenciales. El análisis es estático y funciona sin MSBuild ni intérprete de Python.

La guía combina carpetas, manifiestos y símbolos ya indexados para reconocer capas, slices y patrones de UI. El perfil por worktree se guarda en `.gentle-graph/profile.json`. Para soluciones .NET incluye los paquetes y las referencias entre proyectos declaradas en los archivos `.csproj`. Las reglas de `guide.json` y los contratos del proyecto tienen prioridad sobre las fronteras inferidas.

Por defecto se usa TypeScript del host cuando está disponible. Establece `GENTLE_GRAPH_TRUST_WORKSPACE_TYPESCRIPT=1` para usar el compilador de un proyecto de confianza o `GENTLE_GRAPH_DISABLE_TOOLCHAINS=1` para usar solo el parser léxico.

[Guía de pruebas A/B, rendimiento y aislamiento de subagentes](docs/gentle-graph-integration.md)

## Cómo sumar un lenguaje

1. Crea un módulo en `lib/gentle-graph/languages/` que implemente `LanguageAdapter`.
2. Declara sus extensiones, extrae símbolos con líneas de origen e implementa `isTestFile`.
3. Reutiliza los helpers de `lexer-core.ts` y añade `resolveRelativeImport` cuando corresponda.
4. Registra el adaptador en `registry.ts` para que lo descubran el indexador completo y JIT.
5. Añade un fixture realista en `tests/languages.test.ts` con un caso positivo y uno que descarte falsos enlaces.
6. Ejecuta `pnpm typecheck` y `pnpm test` con las herramientas del host. Esta distribución declara **Node 24 o superior**. Node 22 queda fuera de su soporte declarado.

## Prueba local exigente sobre Gentle Shell

Con Node 24+, Git y tu Pi autenticado, ejecuta desde Gentle Graph:

```powershell
node scripts/bench-gentle-shell.mjs "C:\repos\gentle-shell" "proveedor/modelo" 1
```

Usa el identificador exacto proveedor/modelo. El razonamiento está fijado en `high`; se puede configurar con `GENTLE_BENCH_THINKING`. El clon de Gentle Shell debe tener las dependencias de desarrollo instaladas. El verificador las utiliza después del turno en el worktree aislado. Un par son dos ejecuciones pagadas con el mismo commit, tarea y configuración.

El benchmark v2 plantea un problema observable al descubrir subagentes. A utiliza Pi con sus herramientas estándar. B recibe Gentle Graph y decide si lo necesita. El informe registra esa decisión. La verificación incluye precedencia, reglas literales de la API existente, avisos y una lectura por archivo durante el descubrimiento de dos agentes. También ejecuta la suite de overlays de Gentle Shell y el compilador TypeScript sobre cada parche.

La aprobación exige calidad y mediciones completas en ambos brazos, más una reducción estricta de tokens totales y de tiempo del agente en cada par. Un par favorable se etiqueta `pilot-pass`. Dos o más pares favorables, con orden alternado, reciben `passed`. La primera regresión detiene las ejecuciones restantes. Lee `informe-ab.md` y `summary.json` en la ruta que imprime el script. Las cifras son específicas de esta tarea y modelo. El tiempo incluye la espera del proveedor. La telemetría `engine-times.jsonl` de B mide el motor dentro de la extensión y `tool-times.jsonl` mide los intervalos de Pi por ID de llamada, que pueden solaparse.

### Reproducir un par guardado sin consumir tokens

Desde Gentle Graph, indica el clon de Gentle Shell y la carpeta que contiene `results.json`, `baseline` y `graph` del par anterior:

```powershell
node scripts/replay-shell-pair.mjs "C:\repos\gentle-shell" "C:\ruta\al\pair-1"
```

El replay usa el SHA de Gentle Shell guardado y el motor del clon actual de Gentle Graph. Extrae las consultas de lectura de la sesión B, las mide con índice nuevo por llamada y luego en secuencia, y guarda tiempos, caracteres y archivos indexados en `replay.json`. Después aplica cada parche a su propio worktree temporal y ejecuta la verificación reforzada. Las operaciones que ocurrieron entre consultas en la sesión original no se reproducen. Cada código de salida y su log permiten distinguir errores de tipos, pruebas fallidas e incidencias de entorno.

[Guía de colaboradores y requisitos para abrir una PR](CONTRIBUTING.md)
