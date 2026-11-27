import { resolveImport } from "./languages/registry.ts";
import fs from "node:fs";
import path from "node:path";
import type { ArchGuideStore, CodeSymbol, GraphIndex } from "./types.ts";

export const GRAPH_DIR = ".gentle-graph";
export const INDEX_FILE = "index.json";
export const GUIDE_FILE = "guide.json";

const memoryIndexCache = new Map<string, GraphIndex>();

type GraphLookup = {
  symbols: CodeSymbol[];
  importers: Map<string, Set<string>>;
  symbolByName: Map<string, CodeSymbol[]>;
  symbolById: Map<string, CodeSymbol>;
  callersByName: Map<string, CodeSymbol[]>;
};

const lookupCache = new WeakMap<GraphIndex, GraphLookup>();
export function symbolNames(name: string): string[] {
  const short = name.split(/::|\./).at(-1)!;
  return name === short ? [name] : [name, short];
}

export function getLookup(index: GraphIndex): GraphLookup {
  const cached = lookupCache.get(index);
  if (cached) return cached;
  const symbols = Object.values(index.files).flatMap(file => file.symbols);
  const symbolById = new Map<string, CodeSymbol>();
  const symbolByName = new Map<string, CodeSymbol[]>();
  const callersByName = new Map<string, CodeSymbol[]>();
  function append(map: Map<string, CodeSymbol[]>, key: string, symbol: CodeSymbol) {
    const entries = map.get(key);
    if (entries) entries.push(symbol);
    else map.set(key, [symbol]);
  }
  for (const symbol of symbols) {
    symbolById.set(symbol.id, symbol);
    for (const name of symbolNames(symbol.name)) append(symbolByName, name, symbol);
    for (const call of symbol.calls) append(callersByName, call, symbol);
  }
  const paths = new Set(Object.keys(index.files));
  const importers = new Map<string, Set<string>>();
  for (const file of Object.values(index.files)) {
    for (const source of file.imports) {
      const match = resolveImport(file.path, source, paths);
      if (!match) continue;
      const parents = importers.get(match) ?? new Set<string>();
      parents.add(file.path);
      importers.set(match, parents);
    }
  }
  const lookup = { symbols, importers, symbolById, symbolByName, callersByName };
  lookupCache.set(index, lookup);
  return lookup;
}

export function invalidateLookup(index: GraphIndex): void {
  lookupCache.delete(index);
}

function ensureGraphDir(projectRoot: string): string {
  const dir = path.join(projectRoot, GRAPH_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function writeAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, path.basename(filePath) === GUIDE_FILE ? 2 : undefined), "utf8");
  fs.renameSync(tmp, filePath);
}

export function clearMemoryCache(projectRoot?: string): void {
  if (projectRoot) {
    memoryIndexCache.delete(path.resolve(projectRoot));
  } else {
    memoryIndexCache.clear();
  }
}

export function loadGraphIndex(projectRoot: string): GraphIndex {
  const resolved = path.resolve(projectRoot);
  const cached = memoryIndexCache.get(resolved);
  if (cached) return cached;

  const filePath = path.join(resolved, GRAPH_DIR, INDEX_FILE);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as GraphIndex;
      if (parsed && parsed.version === 2 && parsed.files) {
        memoryIndexCache.set(resolved, parsed);
        return parsed;
      }
    } catch {
      // Índice corrupto: reconstrucción limpia
    }
  }

  const fresh: GraphIndex = {
    version: 2,
    projectRoot: resolved,
    updatedAt: new Date(0).toISOString(),
    files: {}
  };
  memoryIndexCache.set(resolved, fresh);
  return fresh;
}

export function saveGraphIndex(projectRoot: string, index: GraphIndex): void {
  const resolved = path.resolve(projectRoot);
  const dir = ensureGraphDir(resolved);
  index.projectRoot = resolved;
  index.updatedAt = new Date().toISOString();
  writeAtomic(path.join(dir, INDEX_FILE), index);
  memoryIndexCache.set(resolved, index);
}

export function loadArchGuide(projectRoot: string): ArchGuideStore {
  const filePath = path.join(path.resolve(projectRoot), GRAPH_DIR, GUIDE_FILE);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ArchGuideStore;
      if (parsed && parsed.version === 1 && (parsed.patterns === undefined || Array.isArray(parsed.patterns))) {
        return { ...parsed, patterns: parsed.patterns ?? [] };
      }
    } catch {
      // Fallback limpio
    }
  }
  return { version: 1, patterns: [] };
}

export function saveArchGuide(projectRoot: string, guide: ArchGuideStore): void {
  const dir = ensureGraphDir(path.resolve(projectRoot));
  writeAtomic(path.join(dir, GUIDE_FILE), guide);
}
