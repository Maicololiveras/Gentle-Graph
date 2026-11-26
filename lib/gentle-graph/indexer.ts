import { gitDirtyFiles, gitListIndexableFiles } from "./git-scope.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isIndexableFile, parseGenericFile } from "./parser-generic.ts";
import { parseSourceFile } from "./parser-ts.ts";
import { invalidateLookup, resolveImport, loadArchGuide, loadGraphIndex, saveArchGuide, saveGraphIndex } from "./store.ts";
import type { GraphIndex, SyncStats } from "./types.ts";

export const SYNC_TTL_MS = 2000;
const MAX_SOURCE_BYTES = 256 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  ".gentle-graph",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "target",
  "__pycache__"
]);

function walkSourceFiles(root: string, current: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkSourceFiles(root, path.join(current, entry.name), acc);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (isIndexableFile(rel) && !/\.(?:min|bundle)\.[cm]?[jt]sx?$/i.test(rel)) {
      acc.push(rel);
    }
  }
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function reconcilePatternsWithIndex(projectRoot: string, index: GraphIndex): number {
  const guide = loadArchGuide(projectRoot);
  if (guide.patterns.length === 0) return 0;

  let changed = false;
  let staleCount = 0;

  for (const pattern of guide.patterns) {
    const [entryFile, entrySymbol] = pattern.entry.split("#");
    let stale = false;
    let reason: string | undefined;

    if (entryFile && !index.files[entryFile]) {
      stale = true;
      reason = `Archivo no encontrado en el índice: ${entryFile}`;
    } else if (entryFile && entrySymbol) {
      const node = index.files[entryFile];
      const exists = node?.symbols.some((s) => s.name === entrySymbol);
      if (!exists) {
        stale = true;
        reason = `Símbolo "${entrySymbol}" no encontrado en ${entryFile}`;
      }
    }

    if (pattern.stale !== stale || pattern.staleReason !== reason) {
      pattern.stale = stale;
      pattern.staleReason = reason;
      changed = true;
    }
    if (stale) staleCount++;
  }

  if (changed) {
    try { saveArchGuide(projectRoot, guide); } catch { /* A read-only guide can still be queried. */ }
  }
  return staleCount;
}

function eligible(file: string): boolean {
  return !/(?:^|\/)(?:\.git|\.gentle-graph|node_modules|dist|build|coverage|\.next|\.turbo|vendor|target|__pycache__)\//.test(file) &&
    !/\.(min|bundle)\.[cm]?[jt]sx?$/i.test(file);
}

export function listWorkspaceFiles(root: string) {
  const tracked = gitListIndexableFiles(root);
  const knownFiles = tracked ?? [];
  if (!tracked) walkSourceFiles(root, root, knownFiles);
  return { knownFiles: knownFiles.filter(eligible), git: tracked !== null };
}

type Scope = { knownFiles: string[]; paths: Set<string>; mode: "full" | "jit"; dirty: string[] };
const scopes = new WeakMap<GraphIndex, { scope: Scope; time: number; stalePatterns: number }>();

export function indexSpecificFiles(projectRoot: string, files: Iterable<string>, options: { followImports?: number; paths?: Set<string>; preview?: boolean } = {}) {
  const root = path.resolve(projectRoot);
  const index = loadGraphIndex(root);
  const paths = options.paths ?? new Set(listWorkspaceFiles(root).knownFiles);
  const stats: SyncStats = { scanned: 0, updated: 0, removed: 0, durationMs: 0, stalePatterns: 0 };
  const start = performance.now();
  const visited = new Set<string>();
  let changed = false;
  function visit(file: string) {
    const cached = index.files[file];
    if (!paths.has(file)) return;
    const abs = path.join(root, file);
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) return;
    const reusable = cached && (!cached.preview || options.preview);
    if (reusable && cached.mtimeMs === stat.mtimeMs) return cached;
    const content = fs.readFileSync(abs, "utf8");
    const hash = sha256(content);
    if (reusable && cached.sha256 === hash) {
      cached.mtimeMs = stat.mtimeMs;
      changed = true;
      return cached;
    }
    // Generated single-line JS occasionally ships without a .min.js suffix.
    if (/\.[cm]?jsx?$/i.test(file) && content.length >= 8192 && content.split(/\r?\n/).some(line => line.length >= 8192)) return;
    const parsed = options.preview ? parseGenericFile(file, content) : parseSourceFile(root, file, content);
    stats.updated++;
    return index.files[file] = { ...parsed, ...(options.preview ? { preview: true } : {}), path: file, sha256: hash, mtimeMs: stat.mtimeMs };
  }
  let frontier = new Set(files);
  for (let depth = 0; frontier.size; depth++) {
    const next = new Set<string>();
    for (const file of frontier) {
      if (visited.has(file)) continue;
      visited.add(file);
      stats.scanned++;
      let node;
      try { node = visit(file); } catch { /* A file can disappear between list and read. */ }
      if (!node && Object.hasOwn(index.files, file)) {
        delete index.files[file];
        stats.removed++;
      }
      if (node && depth < (options.followImports ?? 0)) {
        for (const source of node.imports) {
          const target = resolveImport(file, source, candidate => paths.has(candidate));
          if (target) next.add(target);
        }
      }
    }
    frontier = next;
  }
  if (stats.updated || stats.removed) invalidateLookup(index);
  if (changed || stats.updated || stats.removed) {
    try { saveGraphIndex(root, index); } catch { /* Keep read-only worktrees usable. */ }
  }
  stats.durationMs = performance.now() - start;
  return { index, stats };
}

export function syncGraphIndex(projectRoot: string, options: boolean | { fullSync?: boolean } = {}) {
  const root = path.resolve(projectRoot);
  const index = loadGraphIndex(root);
  const previous = scopes.get(index);
  const force = options === true || (typeof options === "object" && options.fullSync);
  if (!force && previous?.scope.mode === "full" && previous.scope.knownFiles.length <= 500 && performance.now() - previous.time < SYNC_TTL_MS) {
    return { index, ...previous.scope, stats: { scanned: 0, updated: 0, removed: 0, durationMs: 0, stalePatterns: previous.stalePatterns } };
  }
  const { knownFiles, git } = listWorkspaceFiles(root);
  const dirty = git && !force && knownFiles.length > 500 ? gitDirtyFiles(root) : null;
  const scope: Scope = { knownFiles, paths: new Set(knownFiles), mode: dirty === null ? "full" : "jit", dirty: dirty ?? [] };
  const patterns = loadArchGuide(root).patterns.map(p => p.entry.split("#")[0]);
  const files = [...Object.keys(index.files), ...(scope.mode === "jit" ? [...scope.dirty, ...patterns] : knownFiles)];
  const { stats } = indexSpecificFiles(root, files, { paths: scope.paths, preview: scope.mode === "jit" });
  if (patterns.length) indexSpecificFiles(root, patterns, { paths: scope.paths });
  stats.stalePatterns = reconcilePatternsWithIndex(root, index);
  scopes.set(index, { scope, time: performance.now(), stalePatterns: stats.stalePatterns });
  return { index, ...scope, stats };
}
