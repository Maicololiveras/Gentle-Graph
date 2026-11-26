import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isIndexableFile } from "./parser-generic.ts";
import { parseSourceFile } from "./parser-ts.ts";
import { GRAPH_DIR, INDEX_FILE, invalidateLookup, lastSync, loadArchGuide, loadGraphIndex, saveArchGuide, saveGraphIndex } from "./store.ts";
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

/**
 * Sincronización incremental delta (mtime + SHA-256) aislada por projectRoot / worktree.
 * También valida que los patrones en guide.json sigan apuntando a código vivo.
 */
export function syncGraphIndex(projectRoot: string, force = false): {
  index: GraphIndex;
  stats: SyncStats;
} {
  const startedAt = Date.now();
  const resolvedRoot = path.resolve(projectRoot);
  const index = loadGraphIndex(resolvedRoot);
  const previous = lastSync.get(index);
  if (!force && previous && performance.now() - previous.time < SYNC_TTL_MS) {
    return { index, stats: { scanned: 0, updated: 0, removed: 0, durationMs: 0, stalePatterns: previous.stalePatterns } };
  }
  let touched = false;
  const currentFiles: string[] = [];
  walkSourceFiles(resolvedRoot, resolvedRoot, currentFiles);

  const seen = new Set(currentFiles);
  let updated = 0;
  let removed = 0;

  for (const existingPath of Object.keys(index.files)) {
    if (!seen.has(existingPath)) {
      delete index.files[existingPath];
      removed++;
    }
  }

  for (const relPath of currentFiles) {
    const absPath = path.join(resolvedRoot, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    if (stat.size > MAX_SOURCE_BYTES) {
      if (index.files[relPath]) { delete index.files[relPath]; removed++; }
      continue;
    }
    const cached = index.files[relPath];
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const hash = sha256(content);
    if (cached && cached.sha256 === hash) {
      touched = true;
      cached.mtimeMs = stat.mtimeMs;
      continue;
    }

    let parsed: ReturnType<typeof parseSourceFile>;
    try {
      parsed = parseSourceFile(resolvedRoot, relPath, content);
    } catch {
      if (cached) { delete index.files[relPath]; removed++; }
      continue;
    }
    index.files[relPath] = {
      path: relPath,
      language: parsed.language,
      mtimeMs: stat.mtimeMs,
      sha256: hash,
      imports: parsed.imports,
      exports: parsed.exports,
      symbols: parsed.symbols
    };
    updated++;
  }

  const indexDiskPath = path.join(resolvedRoot, GRAPH_DIR, INDEX_FILE);
  if (updated || removed) invalidateLookup(index);
  if (updated || removed || touched || !fs.existsSync(indexDiskPath)) {
    try { saveGraphIndex(resolvedRoot, index); } catch { /* Read-only worktrees use the memory index. */ }
  }

  const stalePatterns = reconcilePatternsWithIndex(resolvedRoot, index);

  lastSync.set(index, { time: performance.now(), stalePatterns });
  return {
    index,
    stats: {
      scanned: currentFiles.length,
      updated,
      removed,
      durationMs: Date.now() - startedAt,
      stalePatterns
    }
  };
}
