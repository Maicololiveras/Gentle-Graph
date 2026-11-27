---
name: gentle-graph-contributor
description: Prepare Gentle Graph changes for review, including adapters, queries, tool contracts and performance evidence.
---

# Gentle Graph contributor

Read [CONTRIBUTING.md](../../CONTRIBUTING.md). Keep the public API in `index.ts`, query logic in `query-guide.ts`, `query-inspect.ts` and `query-impact.ts`, and language adapters in `languages/`. Keep zero declared npm dependencies and avoid new external binaries.

Respect the output limits. The general guide ceiling is 2,400 characters and the compact guide uses the stricter 1,199-character cap. Inspection and guides with snippets allow 3,000 characters. Impact allows 2,000. Keep `GRAPH_PROMPT_HINT` static and within its approximate 24-token budget.

Report the typecheck result, passing test count, 30,000-file benchmark p95 and Linux/Windows CI status in the PR summary. Identify the OS tested locally. For engine, tool or prompt changes, include A/B token and timing results with equivalent verified quality.
