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

Cada worktree conserva su índice en `.gentle-graph/index.json`. Los patrones compartidos viven en `.gentle-graph/guide.json`, que puedes versionar. Las relaciones entre símbolos y las pruebas sugeridas son heurísticas. Conviene revisar los resultados cuando haya símbolos homónimos o llamadas dinámicas.

[Integrar con Gentle Shell y configurar subagentes](docs/gentle-graph-integration.md)

## Rendimiento

La extensión carga el índice en la primera consulta. Durante los dos segundos siguientes, las consultas del mismo worktree reutilizan el escaneo anterior. Al vencer esa ventana, el motor compara las fechas de modificación y calcula SHA-256 para los archivos que cambiaron. Omite archivos mayores de 256 KiB y fuentes con sufijos como `.min.js` y `.bundle.js`.

Los mapas en memoria permiten buscar directamente un símbolo por nombre o identificador y recuperar sus llamadores por nombre. El tiempo de recorrer dependencias y de preparar recomendaciones depende del número de resultados. La respuesta de la extensión tiene un máximo de 2400 caracteres para guía, 3000 para inspección y 2000 para impacto.

### Indexado progresivo en monorepos

En un worktree Git con más de 500 rutas de código, la guía selecciona hasta 15 candidatos por intención y sigue sus imports relativos un salto. Las rutas modificadas y los patrones registrados se revisan aunque queden fuera de esos candidatos. Una guía en frío usa el parser ligero, y las consultas de referencias afinan las entradas con el parser habitual. En repos pequeños, o si Git no permite descubrir las rutas, se conserva la sincronización completa.

Las consultas de inspección e impacto buscan referencias literales en el árbol de trabajo y amplían los candidatos para seguir llamadores e importadores transitivos. Un símbolo frecuente puede requerir más de 80 candidatos. Los mapas permiten buscar un nombre en tiempo constante; enumerar todos sus dependientes cuesta al menos lo que cuesta recorrerlos. Las llamadas dinámicas y los nombres ambiguos conservan las limitaciones del parser.

Para medir una guía en frío en tu máquina:

```sh
node scripts/bench-jit.mjs 5000
node scripts/bench-jit.mjs 30000
```

El cronómetro incluye la consulta, el descubrimiento de rutas y la escritura del índice. La creación del repositorio de prueba y el arranque de Node quedan fuera. Para validar cambios, ejecuta `pnpm test`. El chequeo `pnpm typecheck` usa el compilador TypeScript, tipos de Node, Pi y TypeBox del entorno de desarrollo de Gentle Shell.
