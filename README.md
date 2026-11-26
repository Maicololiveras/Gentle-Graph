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
