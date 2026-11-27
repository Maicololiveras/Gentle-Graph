---
name: gentle-graph
description: Find reusable code, callers and dependents when the location or impact of a change is uncertain.
---

# Gentle Graph

Use `graph_guide` to locate a reusable module, `graph_inspect` to find a symbol and its callers, or `graph_impact` to identify dependents and related tests before a change.

After `graph_guide`, use `read` with `offset` and `limit` on the reported lines. Widen the range if you need more context.

When you already know the file, read the relevant range directly. Use `rg` or `grep` for a literal match. Reuse evidence from earlier calls.

Keep queries in the assigned worktree. Use `graph_register_pattern` to record confirmed reuse decisions that should guide future work.
