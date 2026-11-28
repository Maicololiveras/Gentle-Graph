<p align="center"><img src="assets/gentle-graph.png" width="640" alt="Gentle Graph"></p>

# Gentle Graph

Gentle Graph gives Gentle Shell agents a code map for each Git worktree. Ask where a feature belongs, open the exact lines of an existing implementation, or trace a symbol to its callers and related tests. The index updates on demand. The engine has no declared npm dependencies and runs without a separate indexing service.

## Quick start

With Git and Node.js 24 or later, run this command from the repository root. The standalone engine works before you install the Pi extension.

```sh
node --input-type=module -e "import { graphInspect } from './lib/gentle-graph/index.ts'; console.log(graphInspect('syncGraphIndex'))"
```

This command inspects the current checkout. To inspect another project, pass `{ projectRoot: '/path/to/project' }` as the second argument.

- [Install in Gentle Shell, configure subagents and verify a session](docs/gentle-graph-integration.md)
- [Run benchmarks, replay a saved pair and interpret results](docs/benchmarks.md)
- [Contribute a language adapter and run CI checks](CONTRIBUTING.md)
- [Agent usage instructions](skills/gentle-graph/SKILL.md) · [Contributor instructions for agents](skills/gentle-graph-contributor/SKILL.md)

## Tool reference

All four tools accept an optional `projectRoot`. Each example below shows a Pi tool name and its JSON arguments.

| Tool | Example arguments | What to look for |
| --- | --- | --- |
| `graph_guide` | `{"intent":"find where agent tool overlays are loaded"}` | Up to three module recommendations with symbol ranges and available caller or test evidence. Use `read` with `offset` and `limit` on the returned lines. Optional `limit` accepts 1–20. |
| `graph_inspect` | `{"symbol":"loadToolOverlays","depth":1}` | Definition, callers and callees. Use a qualified name such as `Store.Get` to narrow an ambiguous match. Depth accepts 1–3. |
| `graph_impact` | `{"target":"loadToolOverlays"}` | Dependent files, related tests and affected patterns for a symbol or file. Check the partial-result flag on broad queries. |
| `graph_register_pattern` | `{"domain":"agents","entry":"lib/agent-tool-overlay.ts","guidance":"Reuse the existing overlay loader."}` | Writes a confirmed reuse rule to the worktree guide. The optional `files` array records associated paths. |

Ordinary guide output is capped at 1,199 characters. Set `includeSnippets: true` to include short excerpts and available caller, callee and implementation relationships for up to three symbols in 3,000 characters. Inspection and impact have limits of 3,000 and 2,000 characters respectively.

## Language and architecture support

| Ecosystem | Examples of indexed evidence |
| --- | --- |
| TypeScript / JavaScript | Functions, class methods, imports and re-exports. The host TypeScript parser is used when available. |
| Python, Go and Rust | Python classes and methods, Go receiver methods, Rust traits and implementations, and language-specific test paths. Qualified names include `Store.Get` and `Client::fetch`. |
| C# / WPF | Interfaces, consumers, XAML bindings, code-behind and ViewModel commands. Try `graph_impact` on a Toolkit method such as `SaveOrderAsync` and inspect its bound view. |
| Java, PHP and Ruby | Types, inheritance, implementations and mixins as applicable. Manifests supply evidence for Spring Boot, Laravel, Symfony or Rails. |
| Svelte / SvelteKit | Imported components, template uses, route files and the standard `$lib` alias. Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`, `$inspect`, `$bindable`) are recorded per family and per binding with real source lines, `$props()` destructuring yields one `Component.prop.<name>` symbol each, snippets (`{#snippet}`), `{@render}` and `<slot>` produce symbols, and event handlers from `on:click` and `onclick` count as call evidence. Route files report a normalized namespace such as `routes/shop/:id`, where route groups are transparent and `[param]`, `[[optional]]` and `[...rest]` segments normalize to `:param`, `param?` and `*param`. Runes modules (`*.svelte.ts`, `*.svelte.js`) are parsed as TypeScript plus their rune families. |
| C / C++ | Local includes, functions, qualified methods and base classes. |
| Kotlin, Swift and Dart | Interfaces, protocols, actors, extensions or mixins as applicable. Framework signals include Android MVVM, Ktor, SwiftUI, Flutter, BLoC and Riverpod. |

The architecture guide combines directories, manifests and indexed symbols. In .NET solutions it also reads project and package references from `.csproj` files. Project contracts and registered patterns take precedence over inferred boundaries. In SvelteKit, a `@sveltejs/kit` or `svelte` dependency and the `+page`, `+layout`, `+server` or `+error` route conventions both supply evidence, and the guide records the `src/routes` / `src/lib` boundary instead of the generic component label. In WPF, follow the binding through its DataContext and command registration. A test that calls a calculation helper gives evidence about that helper. Verify the command's own execution, enablement and binding separately.

SvelteKit limitations: virtual modules (`$app/*`, `$env/*`, `$service-worker`) resolve to nothing because they do not exist in the checkout, and a custom alias declared in `svelte.config.js` stays unresolved because the import hook receives no project root. Components used only through `<svelte:component>` or a dynamic `this` expression cannot be inferred statically.

## Indexing and storage

Small repositories and directories outside Git use a full incremental sync. Above 500 indexable paths in Git, the guide selects up to 15 candidates by intent and follows relative imports one hop. Changed paths and registered patterns also inform indexing. Symbol queries can expand the search as needed. A two-second session cache means a new file or edit may take that long to appear. The engine checks modification times and hashes changed content, skipping files over 256 KiB and minified bundles.

TS/JS impact analysis follows relative imports and re-exports. Other adapters can search by name. Dynamic calls and duplicate names can make results ambiguous. If expansion exceeds its 1,500 ms budget, impact reports a partial result. Suggested tests are starting points for verification.

| Worktree file | Purpose |
| --- | --- |
| `.gentle-graph/index.json` | Regenerable index for small indexed sets. |
| `.gentle-graph/index.sqlite` | SQLite WAL storage above 2,000 **indexed files**. An existing database is reused. Schema v2 supports transactional migration, indexed edges and FTS5 search over paths, tags and symbols. |
| `.gentle-graph/profile.json` | Generated architecture profile. |
| `.gentle-graph/guide.json` | Human-readable reuse patterns. Commit this file to share decisions with the team. |

Set `GENTLE_GRAPH_STORE=json` for NFS or mounted SMB storage. UNC paths select JSON automatically. Set `GENTLE_GRAPH_TRUST_WORKSPACE_TYPESCRIPT=1` to allow the compiler from a trusted workspace, or `GENTLE_GRAPH_DISABLE_TOOLCHAINS=1` to use lexical parsing only.
