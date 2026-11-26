# Integrar con Gentle Shell

La integración nativa se preparó sobre `Gentleman-Programming/gentle-shell` en el commit `d397fab`.

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
