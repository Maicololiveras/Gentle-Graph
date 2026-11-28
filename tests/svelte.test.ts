import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { graphGuide, graphImpact, graphInspect } from "../lib/gentle-graph/index.ts";
import { clearMemoryCache } from "../lib/gentle-graph/store.ts";
import { isIndexableFile, isTestFile, parseSourceFile, resolveImport } from "../lib/gentle-graph/languages/registry.ts";

function project(t: TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gentle-svelte-"));
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return { projectRoot: root };
}

it("SvelteKit links component use and script imports through $lib",async t=>{
  const opts=project(t,{"src/routes/+page.svelte":'<script lang="ts">\nimport Card from "$lib/Card.svelte";\nexport function loadData() { return fetchData(); }\n</script>\n<Card />',
    "src/lib/Card.svelte":"<article>Card</article>", "src/routes/+page.server.ts":"export function load() {}"});
  const page=graphInspect("src/routes/+page.svelte#+page",opts)[0];
  assert(page.callees.some(c=>c.name==="Card"));
  assert.deepEqual(page.implementations,[]);
  assert(graphGuide("page",opts).architecture.includes("SvelteKit"));
  const {resolveImport}=await import("../lib/gentle-graph/languages/registry.ts");
  assert.equal(resolveImport(page.symbol.file,"$lib/Card.svelte",new Set(["src/lib/Card.svelte"])),"src/lib/Card.svelte");
  assert(isTestFile("component.test.svelte"));
});

describeSvelte5();

function describeSvelte5() {
  const runes = `<script lang="ts">\n  let { title, count = $bindable(0) }: { title: string; count?: number } = $props();\n  let doubled = $derived(count * 2);\n  let raw = $state(0);\n  $effect(() => { console.log(doubled); });\n  function increment() { raw += 1; }\n</script>\n<h1>{title}</h1>\n<button on:click={increment} onclick={increment}>{doubled}</button>\n<slot name="footer" />`;

  it("Svelte 5 runes become addressable symbols with real source lines", t => {
    const parsed = parseSourceFile(".", "src/lib/Counter.svelte", runes);
    const props = parsed.symbols.find(s => s.name === "Counter.props");
    assert(props, "expected a props contract symbol");
    assert.equal(props.kind, "property");
    assert.equal(props.line, 2);
    for (const name of ["Counter.state", "Counter.derived", "Counter.effect"])
      assert(parsed.symbols.some(s => s.name === name), "expected " + name);
    const state = parsed.symbols.find(s => s.name === "Counter.state")!;
    assert.equal(state.line, 4);
    assert.equal(parsed.symbols.find(s => s.name === "increment")?.kind, "function");
  });

  it("Svelte 5 snippets, slots and events are evidence, not components", t => {
    const parsed = parseSourceFile(".", "src/lib/Counter.svelte",
      `<script>\n  import Badge from "$lib/Badge.svelte";\n</script>\n{#snippet row(item)}<li>{item}</li>{/snippet}\n{@render row(1)}\n<Badge />\n<slot name="footer" />\n<div on:click={noop} onclick={noop}></div>`);
    const component = parsed.symbols.find(s => s.name === "Counter")!;
    assert(component.calls.includes("Badge"), "component tags stay call evidence");
    assert(parsed.symbols.some(s => s.name === "row" && s.kind === "function"), "snippet symbol");
    const snippet = parsed.symbols.find(s => s.name === "row")!;
    assert.equal(snippet.line, 4);
    // `{@render row(1)}` invokes the snippet, so the render tag surfaces it.
    assert(component.calls.includes("row"), "{@render} records the rendered snippet");
    assert(parsed.symbols.some(s => s.name === "Counter.slot.footer" && s.kind === "property"), "named slot symbol");
  });

  it("Svelte template negatives never become callees", t => {
    const parsed = parseSourceFile(".", "src/routes/+page.svelte",
      `<svelte:head><title>Home</title></svelte:head>\n<div class="wrapper"><span>text</span></div>\n{#if true}<p>block</p>{/if}\n<lowercase />`);
    const component = parsed.symbols.find(s => s.name === "+page")!;
    for (const bad of ["svelte:head", "div", "span", "p", "title", "lowercase"])
      assert(!component.calls.includes(bad), "must not call " + bad);
    // The file declares its own component and, being a route, the route node.
    assert.deepEqual(parsed.symbols.filter(s => s.name !== "+page" && s.name !== "routes"), []);
  });

  it("SvelteKit routes normalize groups and params and link their server module", async t => {
    const opts = project(t, {
      "src/routes/(app)/shop/[id]/+page.svelte": `<script lang="ts">\n  import { load } from "./+page.server";\n</script>\n<h1>Item</h1>`,
      "src/routes/(app)/shop/[id]/+page.server.ts": "export function load() { fetchItem(); }",
      "src/routes/(app)/+layout.svelte": "<nav>Menu</nav>"
    });
    const page = parseSourceFile(opts.projectRoot, "src/routes/(app)/shop/[id]/+page.svelte",
      `<script lang="ts">\n  import { load } from "./+page.server";\n</script>\n<h1>Item</h1>`);
    assert(page.symbols.some(s => s.name === "+page"), "the route component keeps its address");
    assert.equal(page.namespace, "routes/shop/:id", "groups drop, params normalize");
    assert(page.imports.includes("./+page.server"), "the page states its server module dependency");
    assert.equal(resolveImport("src/routes/(app)/shop/[id]/+page.svelte", "./+page.server",
      new Set(["src/routes/(app)/shop/[id]/+page.server.ts"])), "src/routes/(app)/shop/[id]/+page.server.ts");
  });

  it("SvelteKit virtual modules and runes modules resolve honestly", async t => {
    const opts = project(t, {
      "src/lib/counter.svelte.ts": "export const counter = 0;",
      "src/routes/+page.svelte": `<script lang="ts">\n  import { counter } from "$lib/counter.svelte";\n  import { page } from "$app/stores";\n</script>`
    });
    const files = new Set(["src/lib/counter.svelte.ts"]);
    assert.equal(resolveImport("src/routes/+page.svelte", "$lib/counter.svelte", files), "src/lib/counter.svelte.ts");
    assert.equal(resolveImport("src/routes/+page.svelte", "$app/stores", files), null);
    // A runes module has no template, so it is addressed by its rune families.
    const runes = parseSourceFile(opts.projectRoot, "src/lib/counter.svelte.ts", "export function bump() { total = $state(0); }");
    assert(runes.symbols.some(s => s.name === "counter.state"), "runes module records its reactive families");
    assert.equal(runes.symbols.find(s => s.name === "bump")?.kind, "function");
    assert(isIndexableFile("src/lib/counter.svelte.ts"));
  });

  it("Svelte test-file conventions follow the SvelteKit project layout", () => {
    for (const file of ["src/lib/a.test.svelte.ts", "src/lib/a.spec.svelte.ts", "src/lib/Card.test.ts"])
      assert(isTestFile(file), "expected test file " + file);
    for (const file of ["src/lib/Card.svelte", "src/routes/+page.svelte"])
      assert(!isTestFile(file), "expected production file " + file);
  });

  it("SvelteKit route files carry a queryable route symbol and namespace", () => {
    const page = parseSourceFile(".", "src/routes/(app)/shop/[id]/+page.svelte", "<h1>Item</h1>");
    const route = page.symbols.find(s => s.name === "routes/shop/:id");
    assert(route, "the route is addressable by its normalized path");
    assert.equal(route.kind, "class");
    assert.equal(page.namespace, "routes/shop/:id");
    assert.equal(route.name, page.namespace, "route symbol and namespace agree");

    const layout = parseSourceFile(".", "src/routes/(app)/+layout.svelte", "<nav>Menu</nav>");
    assert.equal(layout.namespace, "routes");
    assert(layout.symbols.some(s => s.name === "routes"), "the root layout is the routes node");
  });

  it("Svelte exported props and dispatched events are the component's public surface", () => {
    // Svelte 4 declares props with `export let` and events through a dispatcher.
    const legacy = parseSourceFile(".", "src/lib/Counter.svelte",
      `<script lang="ts">\n  import { createEventDispatcher } from "svelte";\n  export let title: string;\n  export let count = 0;\n  const dispatch = createEventDispatcher();\n  function inc() { dispatch("change", count + 1); }\n  function save() { dispatch("save"); }\n</script>\n<button on:click={inc}>+</button>`);
    assert(legacy.symbols.some(s => s.name === "Counter.prop.title" && s.kind === "property"), "export let is a prop");
    assert(legacy.symbols.some(s => s.name === "Counter.prop.count" && s.kind === "property"), "export let with a default is a prop");
    assert(legacy.symbols.some(s => s.name === "Counter.event.change" && s.kind === "event"), "dispatched event name is public surface");
    assert(legacy.symbols.some(s => s.name === "Counter.event.save" && s.kind === "event"), "event without a payload too");
  });

  it("a consumer passing a prop is connected to that prop, not only to the component", t => {
    const opts = project(t, {
      "src/lib/Card.svelte": `<script lang="ts">\n  let { title, count = 0 } = $props();\n</script>\n<article>{title}{count}</article>`,
      "src/routes/+page.svelte": `<script lang="ts">\n  import Card from \"$lib/Card.svelte\";\n  let { data } = $props();\n</script>\n<Card title={data.name} count={3} />`
    });
    // The prop symbols exist today; the question is whether the consumer is an edge.
    const [title] = graphInspect("Card.prop.title", opts);
    assert(title, "the prop symbol is addressable");
    assert(title.callers.some(c => c.name === "+page"),
      "the page that passes title is a caller of that prop");
    const [body] = graphInspect("Card", opts);
    assert(body.callers.some(c => c.name === "+page"), "the component itself keeps its caller");
  });

  it("a consumer listening to a component event is a caller of that event", t => {
    const opts = project(t, {
      "src/lib/Counter.svelte": `<script>\n  import { createEventDispatcher } from "svelte";\n  const dispatch = createEventDispatcher();\n  export let label;\n  function pick() { dispatch("choose", label); }\n</script>\n<button on:click={pick}>{label}</button>`,
      "src/routes/+page.svelte": `<script>\n  import Counter from \"$lib/Counter.svelte\";\n  function onChoose(e) { console.log(e); }\n</script>\n<Counter label=\"x\" on:choose={onChoose} />`
    });
    const [event] = graphInspect("Counter.event.choose", opts);
    assert(event, "the dispatched event is addressable");
    assert.equal(event.symbol.kind, "event");
    assert(event.callers.some(c => c.name === "+page"), "the listener is a caller of that event");
    // A listener must not be mistaken for a prop named `on`.
    const [body] = graphInspect("Counter", opts);
    assert(!body.callees.some(c => c.name.includes("prop.on")), "on:choose is not a prop");
  });

  it("SvelteKit route server modules report their route namespace", () => {
    const server = parseSourceFile(".", "src/routes/(app)/shop/[id]/+page.server.ts", "export function load() {}");
    assert.equal(server.namespace, "routes/shop/:id", "+page.server.ts belongs to the same route");
    assert(server.symbols.some(s => s.name === "load"), "its load is still addressable");

    const endpoint = parseSourceFile(".", "src/routes/api/items/+server.ts", "export async function GET() {}");
    assert.equal(endpoint.namespace, "routes/api/items", "+server.ts belongs to its route");
    assert(endpoint.symbols.some(s => s.name === "GET"));

    const hooks = parseSourceFile(".", "src/hooks.server.ts", "export function handle() {}");
    assert.equal(hooks.namespace, undefined, "hooks are not a route");
  });

  it("SvelteKit page and its server module share one route, and impact crosses it", t => {
    const files = {
      "src/routes/(app)/shop/[id]/+page.svelte": `<script lang="ts">\n  import { load } from "./+page.server";\n</script>\n<h1>Item</h1>`,
      "src/routes/(app)/shop/[id]/+page.server.ts": "import { fetchItem } from \"$lib/api\";\nexport function load() { return fetchItem(); }",
      "src/lib/api.ts": "export function fetchItem() { return 1; }"
    };
    const opts = project(t, files);
    const hits = graphInspect("routes/shop/:id", opts);
    assert(hits.length >= 2, "the route resolves to every file that implements it");
    const routeFiles = new Set(hits.map(h => h.symbol.file));
    assert(routeFiles.has("src/routes/(app)/shop/[id]/+page.svelte"), "the page belongs to the route");
    assert(routeFiles.has("src/routes/(app)/shop/[id]/+page.server.ts"), "its server module belongs to the route");
    assert(graphImpact("fetchItem", opts).affectedFiles.includes("src/routes/(app)/shop/[id]/+page.server.ts"),
      "impact from a lib helper reaches the server module that uses it");
  });
}


it("a rest element is not a named prop", () => {
  // `{...rest}` collects unknown props; it does not declare one called "rest".
  const parsed = parseSourceFile(".", "src/lib/A.svelte",
    '<script lang="ts">\n  let { title, ...rest } = $props();\n</script>');
  assert(parsed.symbols.some(s => s.name === "A.prop.title"), "a named prop is kept");
  assert(!parsed.symbols.some(s => s.name === "A.prop.rest"), "the rest binding is not a prop");
  const onlyRest = parseSourceFile(".", "src/lib/B.svelte", '<script>let { ...all } = $props();</script>');
  assert(!onlyRest.symbols.some(s => s.name.includes(".prop.")), "a lone rest element declares no prop");
});

it("a renamed destructured prop keeps its public name", () => {
  // `{ title: t }` declares the prop `title`, bound locally to `t`.
  const parsed = parseSourceFile(".", "src/lib/B.svelte",
    '<script lang="ts">\n  let { title: t, count: c = 0 } = $props();\n</script>');
  assert(parsed.symbols.some(s => s.name === "B.prop.title"), "the public name is title");
  assert(parsed.symbols.some(s => s.name === "B.prop.count"), "count too");
  assert(!parsed.symbols.some(s => s.name === "B.prop.t"), "the local alias is not a prop");
});

it("a shorthand prop is still a prop", () => {
  // `<Card {session} />` is sugar for `<Card session={session} />`.
  const parsed = parseSourceFile(".", "src/routes/+page.svelte",
    '<script>\n  import Card from "$lib/Card.svelte";\n</script>\n<Card {session} highlighted />');
  const body = parsed.symbols.find(s => s.name === "+page");
  assert(body, "the page component exists");
  assert(body.calls.includes("Card.prop.session"), "the shorthand prop is an edge");
  assert(body.calls.includes("Card.prop.highlighted"), "the boolean shorthand too");
  assert(!body.calls.includes("Card.prop.import"), "an import must not become a prop");
});

it("an explicit prop and a shorthand prop of the same name are one edge", () => {
  const parsed = parseSourceFile(".", "src/routes/+page.svelte",
    '<script>\n  import Card from "$lib/Card.svelte";\n</script>\n<Card session={a} {session} />');
  const body = parsed.symbols.find(s => s.name === "+page")!;
  assert.equal(body.calls.filter(c => c === "Card.prop.session").length, 1, "deduplicated");
});
