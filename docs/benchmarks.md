# Benchmarking Gentle Graph

Choose the measurement that answers your question. The JIT benchmark times the engine on a generated repository. Replay checks a saved pair locally. The agent comparisons send prompts to the selected provider and measure the complete implementation task, including provider wait time.

## Cold-index performance

```sh
node scripts/bench-jit.mjs 5000
node scripts/bench-jit.mjs 30000 7 --check
```

The script creates the Git fixture once, clears the graph index and starts a fresh Node process for each sample. Cold-guide timing includes path discovery, the query and index publication performed during the query. Fixture creation and process startup are outside the timer. The OS can retain its filesystem cache. With seven repetitions the reported nearest-rank p95 is the largest sample.

The p95 gates are below 150 ms for the cold guide, 15 ms for architecture detection and 2 ms per file for the small Python parser fixture. CI also runs `node scripts/bench-queries.mjs benchmark-host` on a checkout of Gentle Shell at `c9b59ea`. These timings measure engine behavior. Use agent comparisons to measure tokens, cost and implementation time.

## Gentle Shell A/B v2

From Gentle Graph, provide a Gentle Shell checkout with its development dependencies, Git, Node.js 24+, an authenticated Pi installation, and the exact provider/model ID. The host checkout must precede the implementation that the task asks the agent to build. The reference revision is `c9b59ea`. Use TypeScript 5.9.3. On Windows, `PI_CLI_JS` can point to Pi's JavaScript entry point.

```powershell
node scripts/bench-gentle-shell.mjs "C:\repos\gentle-shell" "openai-codex/gpt-6.2-sol" 1 "C:\benchmarks\overlay-pilot"
```

Create the parent output directory beforehand and give the run a fresh directory name. One pair means two paid sessions. A has the standard toolset. B can choose Gentle Graph. Both start from the same commit, task and reasoning setting (`high` by default, configurable through `GENTLE_BENCH_THINKING`). The task concerns wildcard subagent tool overlays. Verification covers precedence, literal per-key API behavior, warnings and reads per file, then runs overlay tests and TypeScript.

Read `informe-ab.md`, `summary.json` and each arm's patch and verification output. A favorable pair requires both verifications to pass, complete measurements and strictly lower total tokens **and** agent time in B. One successful pair is a `pilot-pass`. Two or more successful pairs with alternating order yield `passed`. The first invalid or unimproved pair stops the run. B's `engine-times.jsonl` measures the engine. Intervals in `tool-times.jsonl` can overlap. Report actual graph use and cached tokens alongside totals.

### Replay an existing pair without model calls

```powershell
node scripts/replay-shell-pair.mjs "C:\repos\gentle-shell" "C:\benchmarks\overlay-pilot\pair-1"
```

Supply the directory containing `results.json`, `baseline` and `graph`. Replay uses the recorded host revision and the current Gentle Graph checkout. It measures the read-only graph queries from B separately with fresh indexes, then in sequence. It writes timings, character counts and indexed-file counts to `replay.json`. It also applies each saved patch in an isolated worktree and reruns verification. Edits interleaved with the original queries are outside the query replay.

## Compare your own task

Write one task in `task.txt`, choose an authenticated provider/model, and supply a verifier that succeeds in a clean worktree. Run this from Gentle Graph to use the current repository as the target:

```sh
node scripts/compare-graph.mjs . task.txt provider/model results node --test tests/gentle-graph.test.ts
```

For example, ask the agent to find Python test detection, add a regression for nested test directories and reuse the existing adapter. The comparator uses fresh sessions at the same commit and randomizes arm order. It records sessions, patches, verifier exits and Pi's reported total tokens, including reported cached context. Agent time excludes subsequent verification. Review patches blind for correctness (0 = incorrect, 1 = partial, 2 = complete), reuse and duplication. Unreviewed fields remain null.

To add CodeGraph to this generic comparator, set `CODEGRAPH_PI_EXTENSION` to its installed Pi extension. If initialization is needed, set `CODEGRAPH_PREPARE_ARGV` to a JSON array containing the executable and arguments. Configure the backend to read its assigned worktree. The comparator records preparation separately, checks the active toolset and requires additional CodeGraph tools. Record the CLI, extension and model versions with the report.

## Windows A/B/C experiment

The dedicated nine-session launcher is available in [PR #10 at revision 758ba5c](https://github.com/Maicololiveras/Gentle-Graph/tree/758ba5c89945a04548ec125a99c8a19c3b3b732f). Run the following commands from a checkout containing that launcher. Its revision is independent of the measured extension.

| Arm | Configuration |
| --- | --- |
| A | Gentle Shell at `c9b59eab57a56224c76b99e1caa9bb94cb113dc8` |
| B | Same host plus CodeGraph over stdio MCP with direct exposure |
| C | Same host plus Gentle Graph at `efeed94d8cf59ea65c7f26251b01551ed2fd29df` |

Use Windows, Node 24, Git, TypeScript 5.9.3, Pi 1.6.0 and a working `codegraph --version`. Both Git clones must contain the pinned commits. The launcher uses the host's installed modules by default. Set `GENTLE_ABC_MODULES` to an alternate modules directory if necessary. If the host supplies a different Pi version, set `GENTLE_ABC_PI_PACKAGE` to the isolated 1.6.0 **package directory containing package.json**.

Configure a working `mcpServers.codegraph` stdio entry in Pi's `mcp.json` or point `GENTLE_ABC_MCP_CONFIG` at that file. Only B gets this server. Its working directory is B's worktree. Use `{worktree}` in arguments requiring an explicit repository path. Optional `CODEGRAPH_PREPARE_ARGV` runs before the session. On Windows use a native executable or invoke a script through Node.

```powershell
node scripts/bench-gentle-shell.mjs --abc "C:\repos\gentle-shell"
```

Authorize the device code in your browser when prompted. The launcher uses a dedicated in-memory OAuth session. All nine worktrees and Pi homes undergo a clean typecheck and an RPC model/tool check before the first prompt. Append `--preflight-only` if you only want those checks. Each invocation starts a new run.

The launcher uses `openai-codex/gpt-6.2-sol` with high reasoning and the original task in orders ABC, BCA and CAB. It runs the pinned verifier and TypeScript separately. It retains verification failures and computes totals over rounds where all three arms were valid. A missing first edit is recorded as unavailable. Nested tool calls use Pi's parent call IDs.

Look under the Windows Documents folder in `Gentle-Graph\benchmarks\abc-efeed94-c9b59ea`. Each run has its own evidence directory. Read `summary.json` and `informe-abc.md` alongside per-arm transcripts, patches and verification logs. Savings are `100 × (reference − C) / reference`; positive values mean C used less. A preflight failure produces no comparable rounds.

[Project overview](../README.md) · [Contributor checks](../CONTRIBUTING.md)
