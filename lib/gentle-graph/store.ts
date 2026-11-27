import { resolveImport } from "./languages/registry.ts";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArchGuideStore, CodeSymbol, GraphIndex } from "./types.ts";

export const GRAPH_DIR = ".gentle-graph";
export const INDEX_FILE = "index.json";
export const GUIDE_FILE = "guide.json";

const memoryIndexCache = new Map<string, GraphIndex>();

type GraphLookup = {
  symbols: CodeSymbol[];
  implementationsByContract: Map<string, CodeSymbol[]>;
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
  const implementationsByContract = new Map<string, CodeSymbol[]>();
  const callersByName = new Map<string, CodeSymbol[]>();
  function append(map: Map<string, CodeSymbol[]>, key: string, symbol: CodeSymbol) {
    const entries = map.get(key);
    if (entries) entries.push(symbol);
    else map.set(key, [symbol]);
  }
  for (const symbol of symbols) {
    symbolById.set(symbol.id, symbol);
    if (symbol.contracts?.length) {
      for (const name of new Set(symbol.contracts ?? [])) append(implementationsByContract, name, symbol);
    }
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
  const lookup = { symbols, implementationsByContract, importers, symbolById, symbolByName, callersByName };
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
  const tmp = `${filePath}.${randomUUID()}.tmp`;
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

const require = createRequire(import.meta.url);
function openDatabase(file: string) {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  } catch (error) { db.close(); throw error; }
}
const sqliteCache = "index.sqlite";
function readSqlIndex(root: string): GraphIndex | undefined {
  const file = path.join(root, GRAPH_DIR, sqliteCache);
  if (!fs.existsSync(file)) return;
  const db = openDatabase(file);
  try {
    const meta = db.prepare("SELECT version, updatedAt FROM metadata").get();
    if (meta?.version !== 7) return;
    const files: GraphIndex["files"] = {};
    for (const row of db.prepare("SELECT path, data FROM files").iterate())
      files[String(row.path)] = JSON.parse(String(row.data));
    return { version: 7, projectRoot: root, updatedAt: String(meta.updatedAt), files };
  } finally { db.close(); }
}
function writeSqlIndex(dir: string, index: GraphIndex, changed: Set<string>, rebuild: boolean) {
  const db = openDatabase(path.join(dir, sqliteCache));
  try {
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS metadata(version INTEGER, updatedAt TEXT); CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, data TEXT)");
    const initialized = !rebuild && db.prepare("SELECT version FROM metadata").get()?.version === 7;
    if (!initialized) db.exec("DELETE FROM files");
    const put = db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?)");
    const remove = db.prepare("DELETE FROM files WHERE path=?");
    for (const key of initialized ? changed : Object.keys(index.files)) {
      if (index.files[key]) put.run(key, JSON.stringify(index.files[key]));
      else remove.run(key);
    }
    db.exec("DELETE FROM metadata");
    db.prepare("INSERT INTO metadata VALUES(7, ?)").run(index.updatedAt);
    db.exec("COMMIT");
  } finally { db.close(); }
}

export function loadGraphIndex(projectRoot: string): GraphIndex {
  const resolved = path.resolve(projectRoot);
  const cached = memoryIndexCache.get(resolved);
  if (cached) return cached;

  const filePath = path.join(resolved, GRAPH_DIR, INDEX_FILE);
  if (!fs.existsSync(filePath)) {
    try {
      const index = readSqlIndex(resolved);
      if (index) { memoryIndexCache.set(resolved, index); return index; }
    } catch { /* Cache is reconstructible without SQLite. */ }
  }
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as GraphIndex;
      if (parsed && parsed.version === 7 && parsed.files) {
        memoryIndexCache.set(resolved, parsed);
        return parsed;
      }
    } catch {
      // Índice corrupto: reconstrucción limpia
    }
  }

  const fresh: GraphIndex = {
    version: 7,
    projectRoot: resolved,
    updatedAt: new Date(0).toISOString(),
    files: {}
  };
  memoryIndexCache.set(resolved, fresh);
  return fresh;
}

export function saveGraphIndex(projectRoot: string, index: GraphIndex, changed: Set<string>): void {
  const resolved = path.resolve(projectRoot);
  const dir = ensureGraphDir(resolved);
  index.projectRoot = resolved;
  index.updatedAt = new Date().toISOString();
  const json = path.join(dir, INDEX_FILE);
  if (Object.keys(index.files).length > 2000 || fs.existsSync(path.join(dir, sqliteCache))) {
    try {
      // A JSON snapshot takes precedence after a previous fallback. Reimport it in full.
      writeSqlIndex(dir, index, changed, fs.existsSync(json));
      fs.rmSync(json, { force: true });
      memoryIndexCache.set(resolved, index);
      return;
    } catch { /* Preserve a usable snapshot when SQLite is unavailable. */ }
  }
  writeAtomic(json, index);
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

export function updateArchGuide(root: string, edit: (guide: ArchGuideStore) => void): void {
  const dir = ensureGraphDir(path.resolve(root));
  const db = openDatabase(path.join(dir, "guide-lock.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    const file = path.join(dir, GUIDE_FILE);
    const guide: ArchGuideStore = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { version: 1, patterns: [] };
    if (guide.version !== 1) throw new Error("Unsupported guide version");
    guide.patterns ??= [];
    edit(guide);
    writeAtomic(file, guide);
    db.exec("COMMIT");
  } finally { db.close(); }
}
