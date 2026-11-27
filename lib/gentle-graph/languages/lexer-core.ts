import type { CodeSymbol, SymbolKind } from "../types.ts";
import type { ParsedFile } from "./types.ts";

export function stripCommentsAndStrings(text: string, style: string): string {
  const python = style === "python";
  let i = 0;
  const parts: string[] = [];
  let start = 0;
  while (i < text.length) {
    const offset = i;
    const c = text[i];
    if (((python || style === "ruby" || style === "php") && c === "#") || (!python && text.startsWith("//", i))) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (!python && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'" || c.charCodeAt(0) === 96) {
      if (style === "rust" && c === "'" && /^'[A-Za-z_]\w*(?!')\b/.test(text.slice(i, i + 64)) && text[i + 2] !== "'") { i++; continue; }
      const verbatim = style === "csharp" && text[i - 1] === "@";
      const delimiter = python && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += delimiter.length;
      while (i < text.length) {
        if (verbatim && text.startsWith('""', i)) { i += 2; continue; }
        if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
        const raw = verbatim || (style === "go" && c.charCodeAt(0) === 96);
        i += !raw && text[i] === "\\" ? 2 : 1;
      }
    } else { i++; continue; }
    parts.push(text.slice(start, offset), text.slice(offset, i).replace(/[^\r\n]/g, " "));
    start = i;
  }
  return parts.join("") + text.slice(start);
}

export function findBraceBlockEnd(lines: string[], startIdx: number, maxLines = 140): number {
  let opened = false, depth = 0;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + maxLines); i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { opened = true; depth++; }
      if (ch === "}" && opened && --depth === 0) return i;
      if (!opened && ch === ";") return i;
    }
  }
  return opened ? Math.min(lines.length - 1, startIdx + maxLines - 1) : startIdx;
}

export function findIndentBlockEnd(lines: string[], startIdx: number, maxLines = 140): number {
  const indent = (line: string) => line.match(/^\s*/)?.[0].replace(/\t/g, "        ").length ?? 0;
  let end = startIdx;
  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + maxLines); i++) {
    if (!lines[i].trim()) continue;
    if (indent(lines[i]) <= indent(lines[startIdx])) break;
    end = i;
  }
  return end;
}

const ignored = new Set("if for while switch catch return typeof sizeof nameof new super function func fn def match using lock await base this".split(" "));
export function extractCalls(bodyText: string, selfName: string, extraIgnoredKeywords: string[] = []): string[] {
  const names = [...bodyText.matchAll(/\b([A-Za-z_$]\w*)\s*(?:<[^<>\n;]+>)?\s*\(/g)].map(m => m[1]);
  return [...new Set(names.filter(n => n !== selfName && !ignored.has(n) && !extraIgnoredKeywords.includes(n)))];
}

export function extractGentleTags(lines: string[], lineIdx: number) {
  const tags: Pick<CodeSymbol, "reuseTag" | "domainTag" | "boundaryTag"> = {};
  for (const line of lines.slice(Math.max(0, lineIdx - 6), lineIdx)) {
    if (!/^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(line)) continue;
    const m = line.match(/@gentle-(reuse|domain|boundary)\s+(.+?)(?:\s*(?:\*\/|-->))?\s*$/);
    if (m) tags[({ reuse: "reuseTag", domain: "domainTag", boundary: "boundaryTag" } as const)[m[1]]] = m[2];
  }
  return tags;
}

export function sourceFile(file: string, content: string, language: string) {
  const lines = content.split(/\r?\n/);
  let masked: string[] | undefined;
  const cleanLines = () => masked ??= stripCommentsAndStrings(content, language).split(/\r?\n/);
  const result: ParsedFile = { language, imports: [], exports: [], symbols: [] };
  function add(name: string, kind: SymbolKind, line: number, end: number, exported: boolean, calls?: string[]) {
    const short = name.split(/::|\./).at(-1)!;
    const symbol: CodeSymbol = {
      id: file + "#" + name, name, kind, file, exported, line: line + 1, endLine: end + 1,
      signature: lines[line].trim().slice(0, 160), ...extractGentleTags(lines, line),
      calls: calls ?? extractCalls(cleanLines().slice(line, end + 1).join("\n"), short)
    };
    result.symbols.push(symbol);
    if (exported) result.exports.push(name);
    return symbol;
  }
  return { lines, get clean() { return cleanLines(); }, result, add };
}
