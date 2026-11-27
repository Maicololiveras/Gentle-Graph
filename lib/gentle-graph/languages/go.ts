import { findBraceBlockEnd, sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";
export const go: LanguageAdapter = {
  id: "go", extensions: [".go"], isTestFile: f => /_test\.go$/i.test(f),
  parse(_root, file, content) {
    const { clean, lines, result, add } = sourceFile(file, content, "go");
    let group = false;
    clean.forEach((line, i) => {
      if (group || /^\s*import\b/.test(line)) {
        if (group || /^\s*import\s*\(/.test(line)) group = !line.includes(")");
        for (const m of lines[i].matchAll(/"([^"\n]+)"/g)) result.imports.push(m[1]);
        return;
      }
      const fn = line.match(/^\s*func\s+(?:\(\s*(?:\w+\s+)?\*?(\w+)(?:\[[^\]]+\])?\s*\)\s*)?(\w+)\s*(?:\[.*?\])?\s*\(/);
      const type = line.match(/^\s*type\s+(\w+)\s+(struct|interface)\b/);
      if (fn) add(fn[1] ? fn[1] + "." + fn[2] : fn[2], fn[1] ? "method" : "function", i, findBraceBlockEnd(clean, i), /^[A-Z]/.test(fn[2]));
      if (type) add(type[1], type[2] === "struct" ? "struct" : "interface", i, findBraceBlockEnd(clean, i), /^[A-Z]/.test(type[1]), []);
    });
    return result;
  }
};
