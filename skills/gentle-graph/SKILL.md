---
name: gentle-graph
description: Localizar piezas reutilizables, llamadores y dependencias cuando la ubicación o el impacto de un cambio sean inciertos.
---

# Gentle Graph

Elige la consulta que resuelva la duda actual. Usa `graph_guide` para encontrar un módulo reutilizable, `graph_inspect` para ubicar un símbolo y sus llamadores, o `graph_impact` para identificar dependientes y pruebas antes de un cambio.

Después de `graph_guide`, usa `read` con `offset` y `limit` sobre las líneas indicadas. Amplía el tramo si falta contexto.

Si ya conoces el archivo, lee directamente el tramo relevante. Para una coincidencia literal, usa `rg` o `grep`. Aprovecha las referencias ya obtenidas y evita repetir una búsqueda que responde la misma pregunta.

Mantén las consultas en el worktree asignado. Registra con `graph_register_pattern` las decisiones de reutilización confirmadas que deban servir para tareas futuras.
