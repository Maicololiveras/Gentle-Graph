import { java } from "./java.ts";
import { php } from "./php.ts";
import { ruby } from "./ruby.ts";
import { svelte } from "./svelte.ts";
import path from "node:path";
import { typescript, lexicalTS } from "./typescript.ts";
import { python } from "./python.ts";
import { go } from "./go.ts";
import { rust } from "./rust.ts";
import { csharp, xaml, generatedCSharp } from "./csharp.ts";
import type { LanguageAdapter } from "./types.ts";

const adapters = new Map<string, LanguageAdapter>();
for (const adapter of [typescript, python, go, rust, csharp, xaml, java, php, ruby, svelte])
  for (const ext of adapter.extensions) adapters.set(ext, adapter);

export const sourceExtensions = [...adapters.keys()];

export function adapterFor(file: string) {
  return adapters.get(path.posix.extname(file).toLowerCase());
}
export function isIndexableFile(file: string) {
  return !!adapterFor(file) && !generatedCSharp.test(file);
}
export function isTestFile(file: string) {
  return !!adapterFor(file)?.isTestFile(file);
}
export function parseSourceFile(root: string, file: string, content: string, preview = false) {
  const adapter = adapterFor(file);
  if (!adapter) throw new Error("Unsupported language: " + file);
  return preview && adapter === typescript ? lexicalTS(file, content) : adapter.parse(root, file, content);
}
export function resolveImport(file: string, spec: string, paths: Set<string>) {
  return adapterFor(file)?.resolveRelativeImport?.(file, spec, paths);
}
