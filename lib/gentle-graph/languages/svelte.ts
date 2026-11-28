import path from "node:path";
import { typescript } from "./typescript.ts";
import { extractCalls, sourceFile } from "./lexer-core.ts";
import type { CodeSymbol, SymbolKind } from "../types.ts";
import type { LanguageAdapter } from "./types.ts";

// A runes module (.svelte.ts / .svelte.js) shares the Svelte reactive semantics
// but has no template. Route files, components and those modules are the three
// shapes this adapter must keep apart.
const runesModule = /\.svelte\.[cm]?[jt]s$/i;
// SvelteKit virtual modules are generated at build time. They never exist in the
// checkout, so resolving them would fabricate an edge to a file nobody can open.
const virtualModule = /^\$(?:app|env|service-worker)(?:\/|$)/;

const commentBlock = /<!--[\s\S]*?-->/g;
const scriptBlock = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const styleBlock = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
// Capitalized tags are components; dotted names are namespaced components.
// Lowercase HTML elements and `<svelte:head>` never match.
const componentTag = /<([A-Z]\w*(?:\.\w+)*)\b/g;
const snippetOpen = /\{#snippet\s+([\w$]+)/g;
const renderTag = /\{@render\s+([\w$]+)/g;
const namedSlot = /<slot\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>/g;
const defaultSlot = /<slot\b(?![^>]*?\bname\s*=)[^>]*>/g;
const svelte4Event = /\bon:[a-z]+(?:\|[a-z]+)*\s*=\s*\{([^{}]*)\}/gi;
const svelte5Event = /\bon(?:click|dblclick|input|change|submit|reset|keydown|keyup|keypress|focus|blur|mouseover|mouseenter|mouseleave|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|scroll|contextmenu)\s*=\s*\{([^{}]*)\}/gi;
const handlerWord = /[A-Za-z_$]\w*/g;
const handlerIgnored = new Set(["event", "target", "value", "true", "false", "null", "undefined", "preventDefault", "stopPropagation"]);
const legacyProp = /^\s*export\s+let\s+([\w$]+)\s*(?::[^=;\n]+)?(?:=|;|$)/gm;
const dispatchCall = /\bdispatch\s*\(\s*["']([\w$-]+)["']/g;
// A component tag with its attribute list, so inline props can be read without
// confusing them with the tag itself.
const componentTagWithAttrs = /<([A-Z]\w*(?:\.\w+)*)\b([^>]*)>/g;
const propAttribute = /(?:^|\s)(?:bind:)?([a-zA-Z_$][\w$-]*)\s*=/g;
// Shorthand: `<Card {session} />` is sugar for `<Card session={session} />`.
const shorthandProp = /(?:^|\s)\{([a-zA-Z_$][\w$]*)\}/g;
// A bare attribute is a boolean prop: `<Card highlighted />`. Directives
// (`on:`, `bind:`, `use:`, `class:`, `transition:`, `in:`, `out:`, `animate:`,
// `let:`, `style:`) are not props.
const booleanProp = /(?:^|\s)([a-zA-Z_$][\w$-]*)(?=\s|\/?$)/g;
const directive = /^(?:on|bind|use|class|transition|in|out|animate|let|style):/;
// Component event listeners: `on:choose` or `on:choose|once`.
const componentEventAttribute = /(?:^|\s)on:([\w$-]+)/g;
// A listener is not a prop: `on:choose={h}` must not also yield a prop `on`.
const eventAttribute = /(?:^|\s)on:[\w$-]+(?:\|[\w-]+)*/g;

// One group per rune family, first occurrence wins for the aggregate symbol.
const runeFamilies = ["props", "state", "derived", "effect", "inspect", "bindable", "host"] as const;
const runeCall = new RegExp("\\$(" + runeFamilies.join("|") + ")(?:\\.(\\w+))?\\s*\\(", "g");
const propsDecl = /(?:let|const|var)\s+\{([^}]*)\}\s*(?::[^=]+)?=\s*\$props\s*\(/;
const bindingDecl = new RegExp("(?:let|const|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*\\$(" + runeFamilies.join("|") + ")", "g");

export function componentName(file: string): string {
  return path.posix.basename(file).replace(runesModule, "").replace(/\.svelte$/i, "");
}

// SvelteKit route identity: groups are transparent, dynamic segments become
// readable keys, and the file convention suffix is dropped.
export function routeNamespace(file: string): string | undefined {
  const match = /^(?:.*\/)?src\/routes\/(.+)$/.exec(file) ?? /^routes\/(.+)$/.exec(file);
  if (!match) return undefined;
  const segments = match[1].split("/").filter(Boolean);
  const leaf = segments.pop() ?? "";
  if (!leaf.startsWith("+")) return undefined;
  const key = segments.filter(segment => !/^\(.*\)$/.test(segment)).map(routeSegment).join("/");
  return key ? "routes/" + key : "routes";
}

// Files an adapter other than Svelte owns (`.ts` server modules) still describe a
// route, so they need the same namespace without a Svelte parse.
export function routeFileNamespace(file: string): string | undefined {
  return /(?:^|\/)\+(?:page|layout|error)(?:\.server)?\.(?:[cm]?[jt]s|svelte)$|(?:^|\/)\+server\.[cm]?[jt]s$/.test(file)
    ? routeNamespace(file)
    : undefined;
}

function routeSegment(segment: string): string {
  const optionalRest = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalRest) return "*" + optionalRest[1] + "?";
  const rest = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (rest) return "*" + rest[1];
  const optional = /^\[\[(.+)\]\]$/.exec(segment);
  if (optional) return optional[1] + "?";
  return segment.replace(/^\[(.+)\]$/, ":$1");
}

function lineAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function lastContentLine(content: string): number {
  const lines = content.split(/\r?\n/);
  let end = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) end = i;
  return end;
}

// Blank a match without moving any later offset.
const mask = (m: string) => m.replace(/[^\n]/g, " ");

export const svelte: LanguageAdapter = {
  id: "svelte",
  extensions: [".svelte"],
  isTestFile: file => /\.(?:test|spec)\.svelte(?:\.[cm]?[jt]s)?$/i.test(file) || /(?:^|\/)(?:tests|__tests__)\/[^/]+\.svelte$/i.test(file),
  resolveRelativeImport(file, spec, files) {
    if (virtualModule.test(spec)) return null;
    // `$lib` follows the standard SvelteKit layout through the TypeScript
    // resolver. Custom `svelte.config.js` aliases stay unresolved because this
    // hook receives no project root; see README limitations.
    return typescript.resolveRelativeImport?.(file, spec, files) ?? null;
  },
  parse(root, file, content) {
    const { result, add } = sourceFile(file, content, "svelte");
    const name = componentName(file);
    const commented = content.replace(commentBlock, mask);
    const withoutStyles = commented.replace(styleBlock, mask);
    const template = withoutStyles.replace(scriptBlock, mask);

    for (const match of withoutStyles.matchAll(scriptBlock)) {
      const start = (match.index ?? 0) + match[0].indexOf(">") + 1;
      const padding = "\n".repeat(lineAt(withoutStyles, start));
      const parsed = typescript.parse(root, file + ".ts", padding + match[1]);
      result.imports.push(...parsed.imports);
      result.exports.push(...parsed.exports);
      for (const symbol of parsed.symbols) result.symbols.push({ ...symbol, file, id: file + "#" + symbol.name });
    }

    if (runesModule.test(file)) {
      // The whole file is TypeScript: runes modules have no template or script tag.
      const parsed = typescript.parse(root, file + ".ts", content);
      result.imports.push(...parsed.imports);
      result.exports.push(...parsed.exports);
      for (const symbol of parsed.symbols) result.symbols.push({ ...symbol, file, id: file + "#" + symbol.name });
      recordRunes(add, name, commented);
      return result;
    }

    const calls: string[] = [...new Set([...template.matchAll(componentTag)].map(m => m[1]))];
    addRenders(template, calls);
    addEventHandlers(template, calls);
    addSnippets(template, calls, file, result.symbols);
    addSlots(template, name, add);
    // Runes live inside `<script>`, which the template mask blanks.
    recordRunes(add, name, commented);
    const namespace = routeNamespace(file);
    result.namespace = namespace;
    const end = lastContentLine(content);
    add(name, "class", 0, end, true, calls);
    // A prop passed inline makes this component a caller of that prop, so a
    // consumer becomes an edge to the exact contract it uses, not just the file.
    const body = result.symbols.find(s => s.name === name && s.kind === "class");
    if (body) for (const [target, props] of inlineProps(template))
      for (const prop of props) body.calls.push(target + ".prop." + prop);
    // Listening to a dispatched event is the other half of the contract: the
    // consumer becomes a caller of `Component.event.name`.
    if (body) for (const [target, events] of inlineEvents(template))
      for (const event of events) body.calls.push(target + ".event." + event);
    // The route itself becomes addressable, so a page, its layout and its server
    // module all resolve to one queryable node instead of three unrelated files.
    if (namespace) add(namespace, "class", 0, end, true, []);
    return result;
  }
};

function addRenders(template: string, calls: string[]) {
  for (const match of template.matchAll(renderTag)) if (!calls.includes(match[1])) calls.push(match[1]);
}

function addEventHandlers(template: string, calls: string[]) {
  for (const pattern of [svelte4Event, svelte5Event])
    for (const match of template.matchAll(pattern))
      for (const word of match[1].match(handlerWord) ?? [])
        if (!handlerIgnored.has(word) && !calls.includes(word)) calls.push(word);
}

function addSnippets(template: string, calls: string[], file: string, symbols: CodeSymbol[]) {
  for (const match of template.matchAll(snippetOpen)) {
    const start = match.index ?? 0;
    const bodyStart = template.indexOf("}", start);
    const end = matchingSnippetEnd(template, bodyStart + 1);
    const body = template.slice(bodyStart + 1, end);
    const snippetCalls = extractCalls(body, match[1]).filter(call => call !== "render");
    const firstLine = template.indexOf("\n", start);
    symbols.push({
      id: file + "#" + match[1], name: match[1], kind: "function", file, exported: false,
      line: lineAt(template, start) + 1, endLine: lineAt(template, end) + 1,
      signature: template.slice(start, Math.min(firstLine < 0 ? template.length : firstLine, start + 160)).trim(),
      calls: snippetCalls
    });
    if (!calls.includes(match[1])) calls.push(match[1]);
  }
}

// Nested snippets are rare but legal: count opens and closes instead of
// stopping at the first terminator.
function matchingSnippetEnd(template: string, from: number): number {
  let depth = 1;
  let index = from;
  const open = /\{#snippet\b/g;
  const close = /\{\/snippet\}/g;
  while (depth > 0) {
    open.lastIndex = index;
    close.lastIndex = index;
    const nextOpen = open.exec(template);
    const nextClose = close.exec(template);
    if (!nextClose) return template.length;
    if (nextOpen && nextOpen.index < nextClose.index) { depth++; index = nextOpen.index + nextOpen[0].length; continue; }
    depth--;
    index = nextClose.index + nextClose[0].length;
    if (depth === 0) return nextClose.index;
  }
  return template.length;
}

function addSlots(template: string, component: string, add: (name: string, kind: SymbolKind, line: number, end: number, exported: boolean, calls?: string[]) => unknown) {
  for (const match of template.matchAll(namedSlot)) {
    const line = lineAt(template, match.index ?? 0);
    add(component + ".slot." + match[1], "property", line, line, true, []);
  }
  for (const match of template.matchAll(defaultSlot)) {
    const line = lineAt(template, match.index ?? 0);
    add(component + ".slot.default", "property", line, line, true, []);
  }
}

// Svelte 5 runes carry the reactive contract of a component. They are recorded
// per family plus one symbol per binding, all with real source lines.
function recordRunes(add: (name: string, kind: SymbolKind, line: number, end: number, exported: boolean, calls?: string[]) => unknown, component: string, scannable: string) {
  const firstLine = new Map<string, number>();
  for (const match of scannable.matchAll(runeCall)) {
    const family = match[1];
    if (!firstLine.has(family)) firstLine.set(family, lineAt(scannable, match.index ?? 0));
  }
  const props = propsDecl.exec(scannable);
  if (props) firstLine.set("props", Math.min(firstLine.get("props") ?? Number.MAX_SAFE_INTEGER, lineAt(scannable, props.index)));
  for (const [family, line] of firstLine) {
    if (family === "bindable" && !props) continue;
    add(component + "." + family, family === "props" || family === "bindable" ? "property" : "const", line, line, family === "props" || family === "bindable", []);
  }
  if (props) for (const prop of props[1].split(",")) {
    const entry = prop.trim();
    // A rest element collects unknown props; it declares no named one.
    if (entry.startsWith("...")) continue;
    // `{ title: t }` declares the public prop `title`, not the local alias `t`.
    const propName = entry.split("=")[0].split(":")[0].trim();
    if (!propName || !/^[\w$]+$/.test(propName)) continue;
    add(component + ".prop." + propName, "property", lineAt(scannable, props.index), lineAt(scannable, props.index), true, []);
  }
  for (const match of scannable.matchAll(bindingDecl)) {
    const family = match[2];
    if (family === "bindable") continue;
    const line = lineAt(scannable, match.index ?? 0);
    add(component + "." + family + "." + match[1], "const", line, line, false, []);
  }
  recordLegacyProps(add, component, scannable);
  recordDispatchedEvents(add, component, scannable);
}

// Svelte 4 declares a prop as `export let`. It is the same public surface as a
// `$props()` destructuring, so it gets the same symbol shape.
function recordLegacyProps(add: (name: string, kind: SymbolKind, line: number, end: number, exported: boolean, calls?: string[]) => unknown, component: string, scannable: string) {
  for (const match of scannable.matchAll(legacyProp)) {
    const line = lineAt(scannable, match.index ?? 0);
    add(component + ".prop." + match[1], "property", line, line, true, []);
  }
}

// A dispatched event is how a Svelte 4 component talks to its parent, so the
// event name is part of its contract. The name is the first argument of
// `dispatch('name')`; anything else is not statically knowable.
function recordDispatchedEvents(add: (name: string, kind: SymbolKind, line: number, end: number, exported: boolean, calls?: string[]) => unknown, component: string, scannable: string) {
  for (const match of scannable.matchAll(dispatchCall)) {
    const line = lineAt(scannable, match.index ?? 0);
    add(component + ".event." + match[1], "event", line, line, true, []);
  }
}

// A component tag may pass props inline. Recording each one against the prop
// symbol is what turns "this page uses Card" into "this page passes title".
function recordPropUses(template: string, propsByComponent: Map<string, Set<string>>) {
  for (const match of template.matchAll(componentTagWithAttrs)) {
    const component = match[1];
    // Drop event listeners before reading attributes, so `on:choose` is not a prop.
    const attributes = match[2].replace(eventAttribute, " ");
    const props = new Set<string>();
    for (const attribute of attributes.matchAll(propAttribute)) props.add(attribute[1]);
    // `{name}` passes the local binding as a prop of the same name.
    for (const attribute of attributes.matchAll(shorthandProp)) props.add(attribute[1]);
    // A bare attribute passes `true`.
    for (const attribute of attributes.matchAll(booleanProp))
      if (!directive.test(attribute[1])) props.add(attribute[1]);
    if (props.size) propsByComponent.set(component, props);
  }
  return propsByComponent;
}

function inlineProps(template: string): Map<string, Set<string>> {
  return recordPropUses(template, new Map());
}

// `on:name={handler}` on a component tag means this file consumes that event.
function inlineEvents(template: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of template.matchAll(componentTagWithAttrs)) {
    const events = new Set<string>();
    for (const attribute of match[2].matchAll(componentEventAttribute)) events.add(attribute[1]);
    if (events.size) found.set(match[1], events);
  }
  return found;
}
