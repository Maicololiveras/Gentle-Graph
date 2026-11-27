# Contributing to Gentle Graph

Use Node.js 24 or later, Git and pnpm. Gentle Shell supplies Pi and TypeBox. For a standalone checkout, install the same development tools as CI:

```sh
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund typescript@5.9.3 @types/node@24.13.3 typebox@1.1.38 @earendil-works/pi-coding-agent@1.6.0
```

## Add or improve a language

1. Implement `LanguageAdapter` in `lib/gentle-graph/languages/<language>.ts`. Preserve file paths, symbol names and source lines. Reuse helpers from `lexer-core.ts` and implement `resolveRelativeImport` where applicable.
2. Register extensions and test-file conventions in `languages/registry.ts` so full and JIT indexing agree. Add architecture evidence in `arch-detector.ts` if the ecosystem needs it.
3. In `tests/languages.test.ts`, add a realistic contract, implementation and consumer. Assert the implementation and the consumer are classified separately. Check positive and negative matches and the adapter's `isTestFile` conventions.
4. Keep parsing in the adapter and query behavior in `query-guide.ts`, `query-inspect.ts` or `query-impact.ts`. Preserve the public API of `index.ts`.

## Linux and Windows conventions

Normalize internal paths to `/` and operate on them with `path.posix`. Use native paths for filesystem access. Split text with `/\r?\n/`. Pass child-process arguments separately, set `windowsHide: true`, and send large term lists to Git over stdin with `git grep -F -f -`. Resolve paths relative to the queried worktree.

## Before opening a pull request

- Run `pnpm typecheck` and `pnpm test`. Include their outcome and the passing test count.
- Run `node scripts/bench-jit.mjs 30000 --check`. Report the cold-guide median and p95. The p95 must be below 150 ms.
- Record the OS used locally and the Linux and Windows CI results when available.
- Obtain approval before changing `package.json`. Keep zero declared npm dependencies and avoid adding external binaries.
- For engine, tool or prompt changes, attach the A/B report for the same commit, model and reasoning level. Both patches must pass verification. Each pair must show strictly fewer total tokens and less agent time with Gentle Graph. Mark outstanding measurements as pending.

[Benchmark commands and acceptance criteria](docs/benchmarks.md) · [Project overview](README.md)
