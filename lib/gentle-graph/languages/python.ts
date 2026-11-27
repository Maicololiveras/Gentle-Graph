import path from "node:path";
import { findIndentBlockEnd, sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";

export const python: LanguageAdapter = {
  id: "python", extensions: [".py"],
  isTestFile: f => /(?:^|\/)(?:tests\/|test_[^/]*\.py$)|_test\.py$/i.test(f),
  resolveRelativeImport(file, spec, paths) {
    const dots = spec.match(/^\.+/)?.[0].length ?? 0;
    const base = path.posix.join(dots ? path.posix.dirname(file) : "", "../".repeat(Math.max(0, dots - 1)), spec.slice(dots).replaceAll(".", "/"));
    return [base + ".py", base + "/__init__.py"].find(f => paths.has(f)) ?? null;
  },
  parse(_root, file, content) {
    const { clean, result, add } = sourceFile(file, content, "python");
    const classes: { name: string; end: number }[] = [];
    clean.forEach((line, i) => {
      while (classes.length && classes.at(-1)!.end < i) classes.pop();
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
      if (from) {
        result.imports.push(from[1]);
        if (/^\.+$/.test(from[1])) for (const part of from[2].split(",")) result.imports.push(from[1] + part.trim().split(/\s/)[0]);
      }
      const imports = line.match(/^\s*import\s+(.+)/);
      if (imports) result.imports.push(...imports[1].split(",").map(s => s.trim().split(/\s/)[0]));
      const decl = line.match(/^\s*(?:async\s+)?(def|class)\s+(\w+)/);
      if (!decl) return;
      const [, kind, name] = decl;
      const end = findIndentBlockEnd(clean, i, clean.length);
      const owner = classes.at(-1);
      add(owner ? owner.name + "." + name : name, kind === "class" ? "class" : owner ? "method" : "function", i, end, !name.startsWith("_"), kind === "class" ? [] : undefined);
      if (kind === "class") classes.push({ name, end });
    });
    return result;
  }
};
