# Install Gentle Graph in Gentle Shell

These steps describe native integration with `Gentleman-Programming/gentle-shell` at `c9b59ea`. The **host checkout** loads the extension. The **project worktree** is the source tree you want agents to analyze. They can be different repositories.

1. Copy the following paths from Gentle Graph into the same locations in the host checkout. The host provides Pi, TypeBox and `lib/append-system-prompt.ts`.

   ```text
   lib/gentle-graph/
   extensions/gentle-graph.ts
   skills/gentle-graph/
   scripts/audit-gentle-graph.mjs
   tests/gentle-graph.test.ts
   ```

2. In the project worktree, merge the entries from the [tool overlay](../.pi/gentle-ai/tools.json) into `.pi/gentle-ai/tools.json`. Preserve existing agent rules. For a shared installation, place the overlay at `<configHome>/agent-overlays.d/gentle-graph.json`. Project settings have higher priority.
3. Add the following entries to the project’s `.gitignore`. Teams can track `.gentle-graph/guide.json` to share reuse patterns.

   ```gitignore
   .gentle-graph/index.json
   .gentle-graph/profile.json
   .gentle-graph/*.sqlite*
   .gentle-graph/*.lock
   .gentle-graph/*.lock.reap
   ```

4. Run `pnpm typecheck`, `pnpm run check:runtime-modules` and `pnpm test` from the host checkout. Start a fresh Gentle Shell session in the project worktree.

## Verify the installation

In Gentle Graph's own checkout, ask an agent: “Use graph_inspect to locate syncGraphIndex and report its source path.” In another repository, substitute a symbol you know exists. Check the returned file and line range. With codemode available, `graph_guide` remains directly declared. The other graph tools can be invoked through codemode, for example as `tools.graph_inspect`. Hosts without that loadout feature can expose them directly.

| Agent role in the supplied overlay | Tools added |
| --- | --- |
| `explore`, `jd-fix-agent`, `gentle-ai-explore` | Guide, inspect, impact |
| `worker`, `gentle-ai-worker` | Guide, inspect, impact, register pattern |
| `verify`, `jd-judge-a`, `jd-judge-b`, `gentle-ai-verify` | Inspect, impact |

The extension resolves the project root in this order: explicit `projectRoot`, the Pi session’s working directory, `GENTLE_WORKTREE_ROOT`, then the process working directory. If a caller or test looks unexpected, first check the active worktree and inspect the cited lines.

## Audit subagent use

Dispatch an exploration task that needs a symbol and its dependents. Inspect the child session transcript, then point the auditor at the directory containing the session JSONL files:

```sh
node scripts/audit-gentle-graph.mjs gentle-agents/sessions
```

The audit summarizes observed tool availability and calls. Measuring duplicate code requires comparing actual changes across equivalent tasks.

## Check isolation across two worktrees

1. Create two worktrees at the same commit. Add `probeAlpha.ts` exporting `probeAlpha` in one and `probeBeta.ts` exporting `probeBeta` in the other.
2. In each worktree dispatch `explore`, `worker`, `verify`, `jd-fix-agent`, `jd-judge-a` and `jd-judge-b`. Start each matching pair concurrently. Ask each agent to inspect its local symbol without passing `projectRoot` and return the file path.
3. Save the twelve distinct child transcripts. Create `matrix.json` as a two-element array. Each entry has `root` (absolute worktree path), `symbol`, `marker` (local filename) and `sessions` (an object mapping each of the six roles to its JSONL path).
4. Run `node scripts/verify-graph-roles.mjs matrix.json`. The verifier checks distinct sessions, overlapping runs for each pair, the working directory and a tool result containing the local marker.

[Tool reference and storage](../README.md) · [Benchmark guide](benchmarks.md)
