import path from "node:path";
import type { CodeSymbol, SymbolKind } from "./types.ts";

export interface ParsedFile {
  language: string;
  imports: string[];
  exports: string[];
  symbols: CodeSymbol[];
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust"
};

const IGNORED_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new",
  "typeof", "instanceof", "await", "import", "export", "function", "class",
  "super", "constructor", "def", "func", "fn", "match", "loop", "print",
  "Array", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set",
  "Error", "RegExp", "Date", "Math", "JSON", "console", "len", "range", "make"
]);

const CALL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

export function detectLanguage(relPath: string): string | null {
  const ext = path.extname(relPath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export function isIndexableFile(relPath: string): boolean {
  return detectLanguage(relPath) !== null;
}

function stripStringsAndComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, " ");
}

function findBlockEnd(lines: string[], startIdx: number, language: string): number {
  if (language === "python") {
    const baseIndent = (lines[startIdx].match(/^(\s*)/)?.[1].length) ?? 0;
    let end = startIdx;
    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 120); i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const indent = (l.match(/^(\s*)/)?.[1].length) ?? 0;
      if (indent <= baseIndent && !l.trim().startsWith("#")) break;
      end = i;
    }
    return end;
  }

  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 120); i++) {
    const cleaned = stripStringsAndComments(lines[i]);
    for (const ch of cleaned) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
        if (opened && depth <= 0) return i;
      }
    }
    if (!opened && i > startIdx + 2 && cleaned.includes(";")) return i;
  }
  return Math.min(lines.length - 1, startIdx + 40);
}

function extractCalls(bodyText: string, selfName: string): string[] {
  const cleaned = stripStringsAndComments(bodyText);
  const calls = new Set<string>();
  for (const m of cleaned.matchAll(CALL_RE)) {
    const callee = m[1];
    if (callee !== selfName && !IGNORED_CALLS.has(callee)) {
      calls.add(callee);
    }
  }
  return [...calls];
}

export function parseGenericFile(relPath: string, content: string): ParsedFile {
  const language = detectLanguage(relPath) ?? "unknown";
  const imports = new Set<string>();
  const exports = new Set<string>();
  const symbols: CodeSymbol[] = [];

  if (language === "typescript" || language === "javascript") {
    for (const m of content.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/gm)) {
      imports.add(m[1]);
    }
    for (const m of content.matchAll(/^\s*export\s+(?:type\s+)?(?:\*|\{[^}]+\})\s+from\s+["']([^"']+)["']/gm)) {
      imports.add(m[1]);
    }
  } else if (language === "python") {
    for (const m of content.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm)) {
      imports.add(m[1] || m[2]);
    }
  } else if (language === "go") {
    for (const m of content.matchAll(/^\s*(?:import\s+)?"([^"]+)"/gm)) {
      imports.add(m[1]);
    }
  } else if (language === "rust") {
    for (const m of content.matchAll(/^\s*use\s+([A-Za-z0-9_:]+)/gm)) {
      imports.add(m[1]);
    }
  }

  const lines = content.split(/\r?\n/);
  let pendingReuse: string | undefined;
  let pendingDomain: string | undefined;
  let pendingBoundary: string | undefined;

  const matchersByLang: Record<string, Array<{ kind: SymbolKind; re: RegExp; nameIdx: number; exportIdx?: number }>> = {
    typescript: [
      { kind: "function", re: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/, nameIdx: 4, exportIdx: 1 },
      { kind: "class", re: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, nameIdx: 4, exportIdx: 1 },
      { kind: "interface", re: /^\s*(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, nameIdx: 2, exportIdx: 1 },
      { kind: "type", re: /^\s*(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*=/, nameIdx: 2, exportIdx: 1 },
      { kind: "const", re: /^\s*(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/, nameIdx: 2, exportIdx: 1 }
    ],
    javascript: [
      { kind: "function", re: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/, nameIdx: 4, exportIdx: 1 },
      { kind: "class", re: /^\s*(export\s+)?(default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, nameIdx: 3, exportIdx: 1 },
      { kind: "const", re: /^\s*(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/, nameIdx: 2, exportIdx: 1 }
    ],
    python: [
      { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameIdx: 1 },
      { kind: "class", re: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, nameIdx: 1 }
    ],
    go: [
      { kind: "function", re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameIdx: 1 },
      { kind: "struct", re: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/, nameIdx: 1 },
      { kind: "interface", re: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\b/, nameIdx: 1 }
    ],
    rust: [
      { kind: "function", re: /^\s*(pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, nameIdx: 2, exportIdx: 1 },
      { kind: "struct", re: /^\s*(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/, nameIdx: 2, exportIdx: 1 },
      { kind: "trait", re: /^\s*(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/, nameIdx: 2, exportIdx: 1 }
    ]
  };

  const matchers = matchersByLang[language] ?? [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const reuseMatch = line.match(/@gentle-reuse\s+(.+?)(?:\*\/|$)/);
    if (reuseMatch) pendingReuse = reuseMatch[1].trim();
    const domainMatch = line.match(/@gentle-domain\s+([A-Za-z0-9_-]+)/);
    if (domainMatch) pendingDomain = domainMatch[1].trim();
    const boundaryMatch = line.match(/@gentle-boundary\s+(.+?)(?:\*\/|$)/);
    if (boundaryMatch) pendingBoundary = boundaryMatch[1].trim();

    for (const matcher of matchers) {
      const m = line.match(matcher.re);
      if (!m) continue;

      const name = m[matcher.nameIdx];
      if (!name) continue;

      let exported = false;
      if (matcher.exportIdx !== undefined) {
        exported = Boolean(m[matcher.exportIdx]);
      } else if (language === "go") {
        exported = /^[A-Z]/.test(name);
      } else if (language === "python") {
        exported = !name.startsWith("_");
      }

      if (exported) exports.add(name);

      const endIdx = findBlockEnd(lines, i, language);
      const bodySlice = lines.slice(i, endIdx + 1).join("\n");
      const calls = extractCalls(bodySlice, name);

      symbols.push({
        id: `${relPath}#${name}`,
        name,
        kind: matcher.kind,
        file: relPath,
        line: i + 1,
        endLine: endIdx + 1,
        exported,
        signature: line.trim().slice(0, 160),
        calls,
        ...(pendingReuse ? { reuseTag: pendingReuse } : {}),
        ...(pendingDomain ? { domainTag: pendingDomain } : {}),
        ...(pendingBoundary ? { boundaryTag: pendingBoundary } : {})
      });

      pendingReuse = undefined;
      pendingDomain = undefined;
      pendingBoundary = undefined;
      break;
    }
  }

  return {
    language,
    imports: [...imports],
    exports: [...exports],
    symbols
  };
}
