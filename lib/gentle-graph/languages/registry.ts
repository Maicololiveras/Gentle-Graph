import path from "node:path";
import { createRequire } from "node:module";
import type { LanguageAdapter } from "./types.ts";

const require = createRequire(import.meta.url);
const loaded = new Map<string, LanguageAdapter>();
const generatedCSharp = /\.(?:g(?:\.i)?|designer|AssemblyInfo)\.cs$/i;
let lexicalTS: typeof import("./typescript.ts").lexicalTS;
const languages: Array<[string, string[], RegExp | null]> = [
  ["typescript", [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], /\.(?:test|spec)\.[^/]+$|(?:^|\/)__tests__\//i],
  ["python", [".py"], /(?:^|\/)(?:tests\/|test_[^/]*\.py$)|_test\.py$/i],
  ["go", [".go"], /_test\.go$/i],
  ["rust", [".rs"], /(?:^|\/)tests\/|_test\.rs$/i],
  ["csharp", [".cs"], /Tests?\.cs$|(?:^|\/)[^/]*\.Tests\//i],
  ["xaml", [".xaml"], null],
  ["java", [".java"], /(?:^|\/)src\/test\/|(?:Tests?|IT)\.java$/i],
  ["php", [".php"], /Test\.php$|(?:^|\/)tests\//i],
  ["ruby", [".rb"], /_(?:spec|test)\.rb$/],
  ["svelte", [".svelte"], /\.(?:spec|test)\.svelte$/],
  ["cpp", [".c",".h",".cpp",".hpp",".cc"], /_test\.(?:c|cpp|cc)$/i],
  ["kotlin", [".kt",".kts"], /Test\.kt$/],
  ["swift", [".swift"], /Tests\.swift$/],
  ["dart", [".dart"], /_test\.dart$/],
];

const byExtension = new Map<string, {id: string; test: RegExp | null}>();
for (const [id, extensions, test] of languages) {
  for (const ext of extensions) byExtension.set(ext, {id, test});
}
export const sourceExtensions = [...byExtension.keys()];

export function languageForExtension(ext: string) {
  return byExtension.get(ext.toLowerCase());
}
function metadata(file: string) {
  return languageForExtension(path.posix.extname(file));
}
function loadAdapter(id: string): LanguageAdapter {
  let adapter = loaded.get(id);
  if (!adapter) {
    const module = require("./" + (id === "xaml" ? "csharp" : id) + ".ts");
    if (id === "typescript") lexicalTS = module.lexicalTS;
    adapter = module[id];
    loaded.set(id, adapter);
  }
  return adapter;
}
export function loadedLanguageAdapters(): string[] {
  return [...loaded.keys()];
}
export function adapterFor(file: string) {
  const entry = metadata(file);
  return entry && loadAdapter(entry.id);
}
export function isIndexableFile(file: string) {
  return !!metadata(file) && !generatedCSharp.test(file);
}
export function isTestFile(file: string) {
  return metadata(file)?.test?.test(file) ?? false;
}
export function parseSourceFile(root: string, file: string, content: string, preview = false) {
  const adapter = adapterFor(file);
  if (!adapter) throw new Error("Unsupported language: " + file);
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return preview && adapter.id === "typescript" ? lexicalTS(file, content) : adapter.parse(root, file, content);
}
export function resolveImport(file: string, spec: string, paths: Set<string>) {
  return adapterFor(file)?.resolveRelativeImport?.(file, spec, paths);
}
