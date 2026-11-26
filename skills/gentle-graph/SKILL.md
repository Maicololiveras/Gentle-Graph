---
name: gentle-graph
description: Reglas breves para consultar Gentle Graph antes de crear código nuevo o refactorizar.
---

# Gentle Graph

1. Antes de crear un archivo, helper o abstracción nueva, llama `graph_guide(intent)` para reutilizar módulos y patrones existentes en lugar de reinventarlos.
2. Antes de editar o refactorizar una función o módulo, llama `graph_inspect(symbol)` y `graph_impact(target)` para verificar `callers`, `callees` y tests afectados.
3. En worktrees, pasa explícitamente `projectRoot` con la raíz del worktree asignado.
4. No bloquees `rg`/`grep`/`read`: úsalos libremente para búsquedas literales o lectura puntual una vez ubicado el camino en el grafo.
5. Al cerrar un cambio que introduce una pieza reutilizable canónica, regístrala con `graph_register_pattern`.
