# Svelte / SvelteKit adapter: analysis, implementation, tests and findings

Author: CODY, Senior Architect (_00_ team), collaborating with Gentle Graph.
Branch: `feat/sveltekit-adapter`. Base: `origin/main` at `0c286bf`.

---

## 1. Starting point

`lib/gentle-graph/languages/svelte.ts` was a 23-line placeholder. It masked
`<script>` blocks, delegated them to the TypeScript parser, collapsed the whole
file into **one** synthetic symbol, and read template usage with a single
capitalised-tag regex:

```
<([A-Z]\w*(?:\.\w+)*)\b
```

Consequences a user could observe:

| Symptom | Cause |
| --- | --- |
| Every query about a component resolved to the filename | one symbol per file, always at line 0 |
| No reactive contract | `$props`, `$state`, `$derived` were never read |
| Snippets, slots and events invisible | only `<Capital>` tags matched |
| No route identity | `+page.svelte` and `+page.server.ts` were unrelated files |
| `.svelte.ts` routed to the wrong adapter | `path.posix.extname` sees only `.ts` |

The README claimed "Imported components, template uses, route files and the
standard `$lib` alias", which was true and far short of what a SvelteKit
developer asks a code graph.

---

## 2. Architecture of the adapter

```
                    ┌──────────────────────────────────────────┐
   .svelte ────────▶│ parse(root, file, content)               │
                    │                                          │
                    │  1. mask comments   <!-- -->  → spaces   │
                    │  2. mask <style>                             │
                    │  3. mask <script>  ──────────────┐       │
                    │                                  │       │
                    │  4. TypeScript parser  ◀─────────┘       │
                    │     → imports, exports, TS symbols        │
                    │                                          │
                    │  5. template analysis (masked text):      │
                    │     components, snippets, slots, events,  │
                    │     props, dispatched events              │
                    │                                          │
                    │  6. runes from the unmasked content       │
                    │  7. route namespace → route symbol        │
                    └──────────────────────────────────────────┘
```

Two masking passes matter, and the order is not arbitrary:

- The **template** is the content with `<script>`, `<style>` and comments
  blanked to spaces. Blanking (not deleting) keeps every line and column
  offset valid, so `lineAt()` maps a match back to its real source line.
- **Runes live inside `<script>`**, which the template mask erases. So rune
  scanning reads the comment-masked content instead, where scripts survive.

Getting this wrong is silent: symbols appear, but at the wrong lines.

### 2.1 Runes: the reactive contract

```
$props()  ──▶ Component.props          (family)
          └─▶ Component.prop.<name>    (one per destructured prop)

$state    ──▶ Component.state   + Component.state.<binding>
$derived  ──▶ Component.derived + Component.derived.<binding>
$effect   ──▶ Component.effect
$inspect  ──▶ Component.inspect
$bindable ──▶ Component.bindable   (only inside a $props declaration)
```

Families give a cheap answer to "is this component reactive, and how?". Per
binding symbols give the real one: a line, a signature, an addressable id.

### 2.2 Template surface

| Svelte construct | Recorded as |
| --- | --- |
| `<Card />`, `<Ns.Card />` | call edge to `Card` |
| `{#snippet row(x)}` | symbol `row`, kind `function`, nesting-aware |
| `{@render row(1)}` | call edge to `row` |
| `<slot name="footer" />` | `Component.slot.footer`, kind `property` |
| `on:click={fn}` / `onclick={fn}` | call edge to `fn` |
| `{#each}`, `{#if}`, `{#await}` | *not* parsed (see §6) |

Lowercase elements, `<svelte:head>`, `<svelte:window>` and `<svelte:component>`
never become callees. A negative test pins this, because a regex on capitalised
tags silently invites those false positives.

### 2.3 Routes: identity the graph can query

A SvelteKit route is not a file, it is a path with conventions:

```
src/routes/(app)/shop/[id]/+page.svelte        → routes/shop/:id
src/routes/(app)/shop/[id]/+page.server.ts     → routes/shop/:id
src/routes/(app)/shop/[id]/+page.ts            → (no route symbol)
src/routes/+layout.svelte                      → routes
src/hooks.server.ts                            → (no route)
```

Normalisation:

| Segment | Becomes |
| --- | --- |
| `(app)` | dropped (a group is organisational only) |
| `[id]` | `:id` |
| `[[opt]]` | `opt?` |
| `[...rest]` | `*rest` |
| `[[...rest]]` | `*rest?` |

**Why a symbol and not just the `namespace` field.** The field already existed
and nothing consumed it as a key: the lookup indexes symbols by name
(`store.ts:24`), so a route becomes queryable only by declaring a symbol with
that name. That is a six-line change instead of touching the lookup, and it is
why `graphInspect("routes/shop/:id")` returns every file that implements the
route — page, layout and server module together.

Server modules are parsed by the **TypeScript** adapter, not this one, so
`routeFileNamespace()` is exported and applied there. Without it, a route's
half would be invisible.

---

## 3. The contract edge: consumer ↔ prop / event

The most valuable addition, and the one that took two rounds to get right.

```
Before:  +page.svelte ──"uses"──▶ Card.svelte
After:   +page.svelte ──▶ Card.svelte
                    └───▶ Card.prop.title      (exactly what it passes)
                    └───▶ Card.prop.count
                    └───▶ Card.event.choose    (if it listens)
```

`graphInspect("Card.prop.title")` now reports the page that passes it, and
impact from a prop reaches both the component and its consumer. That answers
"what breaks if I rename this prop", which had no answer before.

### 3.1 Every shape a prop can take

| Written as | Public prop | Why |
| --- | --- | --- |
| `let { title } = $props()` | `title` | destructuring |
| `let { title: t } = $props()` | `title` | the alias is local, the contract is `title` |
| `let { ...rest } = $props()` | *none* | rest collects the unnamed; it declares nothing |
| `export let title` (Svelte 4) | `title` | same contract, older syntax |
| `<Card title={x} />` | `title` | explicit |
| `<Card {title} />` | `title` | shorthand |
| `<Card highlighted />` | `highlighted` | bare attribute is `true` |
| `<Card on:choose={h} />` | event `choose` | a listener is not a prop |

Each row is a test. Three of them were **bugs found by running against real
projects**, not by reasoning:

- `{...rest}` produced a prop literally named `rest`.
- `{session}` shorthand produced no edge at all — the most common call shape in
  `gentle-companion/ui`.
- Bare `highlighted` produced no edge.

---

## 4. Verification

### 4.1 Unit and integration

`tests/svelte.test.ts`, 17 tests. `package.json` is **not** modified: the
`test` script lists files explicitly, so `tests/languages.test.ts` imports the
new suite the same way this repository already loads
`tests/sqlite-store.test.ts`.

```
typecheck                     exit 0
suite                         83 tests, 82 pass, 1 fail (pre-existing)
regressions vs base commit    0
```

The single failure is `reports cold query telemetry and finds an untracked
consumer in a fresh worktree`: the `mode: "unknown"` defect from the 1500 ms
budget in `query-session.ts`. It reproduces on pristine `main` via `git archive`
and is unrelated to this work.

### 4.2 Against real projects

Fixtures I write share my blind spots. Three real codebases disagree with them.

**gentle-companion/ui** — 36 `.svelte`, 5 runes modules, nested `[id]` routes:

```
routes/sessions/:id                 → src/routes/sessions/[id]/+page.svelte
routes/automations/:id/runs/:runId  → .../runs/[runId]/+page.svelte
architecture                        → SvelteKit
SessionCard.prop.session            → connected from +page.svelte  (shorthand)
SessionCard.prop.highlighted        → connected from +page.svelte  (bare)
```

**open-webui** — 578 `.svelte`, 46 routes, Svelte 5.53 / Kit 2.5:

```
architecture  → SvelteKit (SvelteKit, Svelte, FastAPI)   ← backend detected too
graphGuide("add a new admin settings page")
              → src/routes/(app)/admin/settings/+page.svelte   ← the exact route
Message.svelte props → chatId, selectedModels, idx, history, messageId, user,
                       setInputText, gotoMessage
ChatControls.prop.submitPrompt → detected (Svelte 4 export let)
```

The guide resolved the route the request implied, not a similar one. That is
the namespace working end to end.

### 4.3 The benchmark gate, measured where it belongs

`CONTRIBUTING.md:23` requires `bench-jit.mjs 30000 --check` with
`coldGuideMs` p95 < 150 ms. On the development machine (load average 15-20) it
fails at 1458 ms, and I first concluded the threshold was miscalibrated.

Run on ricardoPC (idle, load 0.9, AMD Athlon 200GE), five consecutive runs:

| Metric | ricardoPC | dev machine | Limit |
| --- | --- | --- | --- |
| `coldGuideMs` p95 | **121-125 ms** | 1458 ms | 150 |
| `architectureMs` p95 | **10-14 ms** | 100 ms | 15 |
| `pythonMsPerFile` p95 | **0.04 ms** | 0.61 ms | 2 |

**The gate passes.** It was never miscalibrated; it was being measured on a
machine oversubscribed four to five times. The lesson is mine: a measurement is
a property of the hardware as much as of the code, and I reported the first
without the second.

---

## 5. Findings that are not this PR

### 5.1 Custom aliases (`#lib/*`) do not resolve — Issue #19, Option C

`gentle-companion/ui` imports through `#lib/SessionCard.svelte`:

```
resolveImport("#lib/SessionCard.svelte") → null
+page.svelte imports → ["svelte", "../assets/..."]   ← #lib/* missing
```

`resolveRelativeImport` receives no `projectRoot`, so no adapter can read
project configuration. This is not theoretical: it silently drops module edges
in a shipping project. Covered by `PROPOSAL-SVELTEKIT-ALIASES.md`; the
maintainer approved Option C and it lives in #19.

### 5.2 Homonymous short names create false callers — for discussion in #19

`graphInspect("MessageInput.event.submit")` on open-webui returns:

```
✓ Placeholder.svelte            the consumer that listens
✗ _resolve_ollama_base_url      backend/open_webui/config.py
✗ PineconeClient.insert         backend/.../pinecone.py
✗ transcribe                    backend/.../audio.py
```

Cause: `symbolNames()` (`store.ts:24`) indexes `A.b.c` under both the full name
**and** the last segment. Any function called `submit` in the project becomes a
caller of the event.

Measured precisely:

```
callers by full name  "MessageInput.event.submit" → 1 correct caller
callers by short name "submit"                    → 5 symbols, 4 spurious
```

It affects props identically: `ChatControls.prop.submitPrompt` reports
`processNextInQueue`, `submitHandler`, `transcribeHandler`.

**Not fixed here.** The short-name index is what makes `Store.Get` findable as
`Get` for all fourteen adapters; changing its precedence is `Risk: item 3` and
needs a decision, not a patch inside a Svelte PR. Raising it in #19 first.

My fixtures never caught this because none of them contained a homonym. Real
code did.

---

## 6. Declared limits

| Not supported | Why |
| --- | --- |
| `<svelte:component this={C}>` | a dynamically chosen component is not statically knowable; reading it would be invention |
| `let:item` slot props (Svelte 4) | a consumer-side alias, not the component's contract |
| `use:action`, `transition:` | behaviour, not public data surface |
| `{@const}` | a template-local binding, not an exported symbol |
| Computed event names `dispatch(name)` | only a literal first argument is read |
| Rune dependency graph | `$effect`/`$derived` dependencies are not modelled; only their existence |
| `svelte.config.js` aliases | §5.1 |

Each of these was checked against source, not assumed. Where a construct exists
and is deliberately skipped, a test or this table says so — silence would read
as support.

---

## 7. Files

| File | Change |
| --- | --- |
| `lib/gentle-graph/languages/svelte.ts` | 23 → 312 lines |
| `lib/gentle-graph/languages/typescript.ts` | route namespace for server modules |
| `lib/gentle-graph/languages/registry.ts` | `.svelte.ts` / `.svelte.js` routing |
| `lib/gentle-graph/arch-detector.ts` | `@sveltejs/kit` / `svelte` signals, routes/lib boundary |
| `tests/svelte.test.ts` | new, 17 tests, 227 lines |
| `tests/languages.test.ts` | imports the new suite; Svelte cases moved out |
| `tests/arch-detector.test.ts` | SvelteKit detection |
| `README.md` | capabilities and declared limits |

`package.json` and `package-lock.json` are identical to `main`.
