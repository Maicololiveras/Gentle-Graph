import path from "node:path";
import { findBraceBlockEnd, sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";
export const rust: LanguageAdapter = {
  id: "rust", extensions: [".rs"], isTestFile: f => /(?:^|\/)tests\/|_test\.rs$/i.test(f),
  resolveRelativeImport(file, spec, paths) {
    const dir = path.posix.dirname(file);
    const parts = spec.split("::");
    const root = parts[0] === "crate" ? file.match(/^(.*?src)\//)?.[1] ?? "." : dir;
    while (["crate", "self"].includes(parts[0])) parts.shift();
    let base = root;
    for (const part of parts) {
      if (part === "super") { base = path.posix.dirname(base); continue; }
      base = path.posix.join(base, part);
      for (const candidate of [base + ".rs", base + "/mod.rs"]) if (paths.has(candidate)) return candidate;
    }
    return null;
  },
  parse(_root, file, content) {
    const { clean, result, add } = sourceFile(file, content, "rust");
    let owner = "", until = -1;
    clean.forEach((line, i) => {
      const imp = line.match(/\buse\s+([^;]+)/);
      const mod = line.match(/\bmod\s+(\w+)\s*;/);
      if (imp || mod) result.imports.push((imp ?? mod)![1]);
      const impl = line.match(/\bimpl(?:\s*<[^>]+>)?\s+([^{}]+)\s*\{/);
      if (impl) {
        owner = impl[1].split(/\s+for\s+/).at(-1)!.trim().split(/[<\s]/)[0];
        until = findBraceBlockEnd(clean, i, clean.length);
      }
      const decl = line.match(/\b(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait)\s+(\w+)/);
      if (!decl) return;
      const method = decl[2] === "fn" && i <= until;
      add(method ? owner + "::" + decl[3] : decl[3], method ? "method" : decl[2] === "fn" ? "function" : decl[2] as "struct" | "enum" | "trait",
        i, findBraceBlockEnd(clean, i), Boolean(decl[1]), decl[2] === "fn" ? undefined : []);
    });
    return result;
  }
};
