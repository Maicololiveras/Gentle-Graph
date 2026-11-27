import { isManifest } from "./arch-detector.ts";
import { gitDirtyFilesSync, gitInventory } from "./git-scope.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isIndexableFile, parseSourceFile, resolveImport } from "./languages/registry.ts";
import { invalidateLookup, loadArchGuide, loadGraphIndex, updateArchGuide, saveGraphIndex } from "./store.ts";
import type { ArchGuideStore, GraphIndex, SyncStats } from "./types.ts";

export const SYNC_TTL_MS = 2000;
const MAX_SOURCE_BYTES = 256 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  ".gentle-graph",
  "node_modules", "bin", "obj", ".vs", "packages", "TestResults",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "target", ".gradle", ".svelte-kit", ".dart_tool", "Pods", ".build", "out",
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
    if ((isIndexableFile(rel) || isManifest(rel) || isContract(rel)) && !/\.(?:min|bundle)\.[cm]?[jt]sx?$/i.test(rel)) {
      acc.push(rel);
    }
  }
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function reconcilePatternsWithIndex(projectRoot: string, index: GraphIndex, guide: ArchGuideStore): number {
  if (guide.patterns.length === 0) return 0;

  const revisions = new Map<string, string>();
  let staleCount = 0;

  for (const pattern of guide.patterns) {
    const [entryFile, entrySymbol] = pattern.entry.split("#");
    let stale = false;
    let reason: string | undefined;

    if (entryFile && !index.files[entryFile] && fs.existsSync(path.join(projectRoot, entryFile))) continue;
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
      revisions.set(pattern.id, pattern.updatedAt);
    }
    if (stale) staleCount++;
  }

  if (revisions.size) {
    try { updateArchGuide(projectRoot, current => {
      for (const checked of guide.patterns) {
        if (!revisions.has(checked.id)) continue;
        const live = current.patterns.find(p => p.id === checked.id && p.updatedAt === checked.updatedAt);
        if (live) { live.stale = checked.stale; live.staleReason = checked.staleReason; }
      }
    }); } catch { /* A read-only guide can still be queried. */ }
  }
  return staleCount;
}

function eligible(file: string): boolean {
  return !/(?:^|\/)(?:\.git|\.gentle-graph|node_modules|bin|obj|\.vs|packages|TestResults|dist|build|coverage|\.next|\.turbo|vendor|target|\.gradle|\.svelte-kit|\.dart_tool|Pods|\.build|out|__pycache__)\//.test(file) &&
    !/\.(min|bundle)\.[cm]?[jt]sx?$/i.test(file);
}

const isContract = (file: string) => /(?:^|\/)contracts\/.*\.(?:md|txt|ya?ml|json)$/i.test(file);

export function listWorkspaceFiles(root: string, tracked = gitInventory(root)) {
  const knownFiles = tracked?.files ?? [];
  if (!tracked) walkSourceFiles(root, root, knownFiles);
  const files: string[] = [], manifests: string[] = [], contracts: string[] = [];
  const folders = new Set<string>([""]);
  // Git emits adjacent files from the same directory. Reuse its exclusion decision.
  let folder = "", skipFolder = false, contractFolder = false;
  let lastExtension = "", knownSourceExtension = false, isCSharp = false;
  for (const file of knownFiles) {
    const slash = file.lastIndexOf("/");
    if (slash + 1 !== folder.length || !file.startsWith(folder)) {
      folder = file.slice(0, slash + 1);
      skipFolder = !eligible(folder);
      contractFolder = /(?:^|\/)contracts\//.test(folder.toLowerCase());
      if (!skipFolder) folders.add(folder);
    }
    if (skipFolder) continue;
    const dot = file.lastIndexOf(".");
    const extension = dot > slash + 1 ? file.slice(dot) : "";
    // Resolve the language once per extension run. Generated C# exclusions
    // depend on the whole filename and must still go through the registry.
    if (extension !== lastExtension) {
      lastExtension = extension;
      knownSourceExtension = !!extension && isIndexableFile("source" + extension);
      isCSharp = extension.toLowerCase() === ".cs";
    }
    if (knownSourceExtension) {
      if (file.indexOf(".", slash + 1) !== dot && /\.(?:min|bundle)\.[cm]?[jt]sx?$/i.test(file)) continue;
      if (isCSharp && !isIndexableFile(file)) continue;
      files.push(file);
      if (file.endsWith("build.gradle.kts") || file.endsWith("Package.swift")) manifests.push(file);
    } else if (isManifest(file)) manifests.push(file);
    if (contractFolder && isContract(file)) contracts.push(file);
  }
  return { knownFiles: files, manifests, contracts, folders, git: tracked !== null, untracked: tracked?.untracked };
}

type Scope = { manifests: string[]; contracts: string[]; knownFiles: string[]; paths: Set<string>; mode: "full" | "jit"; dirty: string[] };
type CachedScope = { scope: Scope; time: number; discoveredAt: number; folders: Set<string>; stalePatterns: number };
const scopes = new WeakMap<GraphIndex, CachedScope>();

function currentJitScope(root: string, index: GraphIndex, cached: CachedScope): boolean {
  // A path can be created, renamed or removed within the TTL. Directory mtimes
  // let synchronous consumers notice these changes without starting Git.
  for (const folder of cached.folders) {
    const stat = fs.statSync(path.join(root, folder), {throwIfNoEntry:false});
    if (!stat || stat.mtimeMs >= cached.discoveredAt) return false;
  }
  for (const file of Object.values(index.files)) {
    if (fs.lstatSync(path.join(root,file.path), {throwIfNoEntry:false})?.mtimeMs !== file.mtimeMs) return false;
  }
  return true;
}

// Every line of at least 8 KiB crosses a 4 KiB boundary. Probe only those
// boundaries, preserving the threshold even after a multiline license banner.
function likelyMinified(content: string): boolean {
  if (content.length < 8192) return false;
  for (let probe = 4095; probe < content.length; probe += 4096) {
    const start = content.lastIndexOf("\n", probe) + 1;
    const newline = content.indexOf("\n", probe + 1);
    const end = newline < 0 ? content.length : newline - Number(content.charCodeAt(newline - 1) === 13);
    if (end - start >= 8192) return true;
  }
  return false;
}

export function indexSpecificFiles(projectRoot: string, files: Iterable<string>, options: { followImports?: number; paths?: Set<string>; preview?: boolean; fullParseFiles?: Set<string>; deferSave?: Set<string>; deadline?:number } = {}) {
  const root = path.resolve(projectRoot);
  const index = loadGraphIndex(root);
  const paths = options.paths ?? new Set(listWorkspaceFiles(root).knownFiles);
  const stats: SyncStats = { scanned: 0, updated: 0, removed: 0, durationMs: 0, stalePatterns: 0 };
  const start = performance.now();
  const visited = new Set<string>();
  const changed = new Set<string>();
  function visit(file: string) {
    const cached = index.files[file];
    if (!paths.has(file)) return;
    const abs = path.join(root, file);
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) return;
    const preview = options.preview && !options.fullParseFiles?.has(file);
    const reusable = cached && (!cached.preview || preview);
    if (reusable && cached.mtimeMs === stat.mtimeMs) return cached;
    const content = fs.readFileSync(abs, "utf8");
    const hash = sha256(content);
    if (reusable && cached.sha256 === hash) {
      cached.mtimeMs = stat.mtimeMs;
      return cached;
    }
    // Generated single-line JS occasionally ships without a .min.js suffix.
    if (/\.[cm]?jsx?$/i.test(file) && likelyMinified(content)) return;
    const parsed = parseSourceFile(root, file, content, preview);
    changed.add(file);
    stats.updated++;
    return index.files[file] = { ...parsed, ...(preview ? { preview: true } : {}), path: file, sha256: hash, mtimeMs: stat.mtimeMs };
  }
  let frontier = new Set(files);
  for (let depth = 0; frontier.size; depth++) {
    const next = new Set<string>();
    for (const file of frontier) {
      if(options.deadline!==undefined && performance.now()>=options.deadline) break;
      if (visited.has(file)) continue;
      visited.add(file);
      stats.scanned++;
      let node;
      try { node = visit(file); } catch { /* A file can disappear between list and read. */ }
      if (!node && Object.hasOwn(index.files, file)) {
        delete index.files[file];
        changed.add(file);
        stats.removed++;
      }
      if (node && depth < (options.followImports ?? 0)) {
        for (const source of node.imports) {
          const target = resolveImport(file, source, paths);
          if (target) next.add(target);
        }
      }
    }
    frontier = next;
  }
  if (stats.updated || stats.removed) invalidateLookup(index);
  if (options.deferSave) {
    for (const file of changed) options.deferSave.add(file);
  } else if (changed.size) {
    try { saveGraphIndex(root, index, changed); } catch { /* Keep read-only worktrees usable. */ }
  }
  stats.durationMs = performance.now() - start;
  return { index, stats };
}

export function syncGraphIndex(projectRoot: string, options: boolean | { fullSync?: boolean; inventory?: ReturnType<typeof gitInventory>; dirty?: string[]; refresh?: boolean } = {}) {
  const root = path.resolve(projectRoot);
  const index = loadGraphIndex(root);
  const previous = scopes.get(index);
  const force = options === true || (typeof options === "object" && options.fullSync);
  const refresh = typeof options === "object" && (options.refresh || options.inventory !== undefined || options.dirty !== undefined);
  if (!refresh && !force && previous && performance.now() - previous.time < SYNC_TTL_MS &&
      (previous.scope.mode === "jit" ? currentJitScope(root, index, previous) : previous.scope.knownFiles.length <= 500)) {
    return { index, ...previous.scope, stats: { scanned: 0, updated: 0, removed: 0, durationMs: 0, stalePatterns: previous.stalePatterns } };
  }
  const discoveredAt = Date.now();
  const { knownFiles, git, contracts, manifests, folders, untracked } = listWorkspaceFiles(root,typeof options==="object" ? options.inventory : undefined);
  const dirty = git && !force && knownFiles.length > 500 ? ((typeof options==="object" ? options.dirty : undefined) ?? gitDirtyFilesSync(root, untracked)) : null;
  const scope: Scope = { knownFiles, manifests, contracts, paths: new Set(knownFiles), mode: dirty === null ? "full" : "jit", dirty: dirty ?? [] };
  const guide = loadArchGuide(root);
  const patterns = new Set(guide.patterns.map(p => p.entry.split("#")[0]));
  const files = [...Object.keys(index.files), ...(scope.mode === "jit" ? [...scope.dirty, ...patterns] : knownFiles)];
  const { stats } = indexSpecificFiles(root, files, { paths: scope.paths, preview: scope.mode === "jit", fullParseFiles: patterns });
  stats.stalePatterns = reconcilePatternsWithIndex(root, index, guide);
  scopes.set(index, { scope, discoveredAt, folders, time: performance.now(), stalePatterns: stats.stalePatterns });
  return { index, ...scope, stats };
}
