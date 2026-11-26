import fs from "node:fs";
import path from "node:path";
import { recommendPath, registerPattern, tokenizeIntent } from "./arch-guide.ts";
import { gitGrepFiles } from "./git-scope.ts";
import { indexSpecificFiles, syncGraphIndex } from "./indexer.ts";
import { getLookup, loadArchGuide } from "./store.ts";
import type {
  CodeSymbol,
  GraphStatus,
  GuideRecommendation,
  ImpactResult,
  InspectResult,
  PatternEntry,
  SymbolRef
} from "./types.ts";

function readBoundedSnippet(projectRoot: string, relFile: string, startLine: number, endLine: number, maxLines = 25): string {
  try {
    const abs = path.join(projectRoot, relFile);
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    const from = Math.max(0, startLine - 1);
    const to = Math.min(lines.length, Math.min(endLine, startLine - 1 + maxLines));
    return lines
      .slice(from, to)
      .map((line, idx) => `${from + idx + 1}: ${line}`)
      .join("\n");
  } catch {
    return "";
  }
}

// Retry broad frontiers without truncation. A failed Git search falls back
// to the full delta so it cannot silently hide callers.
function searchFrontier(root: string, scope: ReturnType<typeof syncGraphIndex>, limit: number) {
  const searched = new Set<string>();
  let complete = scope.mode === "full";
  return (terms: Iterable<string>): boolean => {
    if (complete) return false;
    const pending = [...new Set(terms)].filter(term => term && !searched.has(term));
    if (!pending.length) return false;
    for (const term of pending) searched.add(term);
    for (let offset = 0; offset < pending.length; offset += 32) {
      const terms = pending.slice(offset, offset + 32);
      let hits = gitGrepFiles(root, terms, limit + 1);
      if (hits && hits.length > limit) hits = gitGrepFiles(root, terms, Infinity);
      if (!hits) {
        indexSpecificFiles(root, scope.knownFiles, { paths: scope.paths });
        complete = true;
        break;
      }
      indexSpecificFiles(root, hits, { paths: scope.paths, followImports: 1 });
    }
    return true;
  };
}

/**
 * @gentle-domain graph
 * @gentle-reuse Punto de entrada principal para guiar al agente antes de crear archivos o abstracciones nuevas.
 */
export function graphGuide(
  intent: string,
  options: { projectRoot?: string; limit?: number } = {}
): GuideRecommendation {
  const resolved = path.resolve(options.projectRoot ?? process.cwd());
  const scope = syncGraphIndex(resolved);
  const { index } = scope;
  if (scope.mode === "jit") {
    const tokens = tokenizeIntent(intent);
    const patterns = loadArchGuide(resolved).patterns;
    const referenced = new Set(patterns.flatMap(p => [p.entry.split("#")[0], ...p.files]));
    const dirty = new Set(scope.dirty);
    const ranked: { file: string; score: number }[] = [];
    for (const file of scope.knownFiles) {
      const name = file.toLowerCase();
      let score = Number(referenced.has(file)) + Number(dirty.has(file));
      for (const token of tokens) if (name.includes(token)) score += 4;
      if (!score || (ranked.length === 15 && score <= ranked[14].score)) continue;
      const pos = ranked.findIndex(item => item.score < score);
      ranked.splice(pos < 0 ? ranked.length : pos, 0, { file, score });
      if (ranked.length > 15) ranked.pop();
    }
    indexSpecificFiles(resolved, ranked.map(row => row.file), { paths: scope.paths, followImports: 1, preview: true });
  }
  return recommendPath(resolved, index, intent, options.limit ?? 5);
}

/**
 * @gentle-domain graph
 * @gentle-reuse Inspecciona firma, código acotado, callees y callers de un símbolo hasta depth saltos.
 */
export function graphInspect(
  symbolQuery: string,
  options: { projectRoot?: string; depth?: number; maxMatches?: number } = {}
): InspectResult[] {
  const resolved = path.resolve(options.projectRoot ?? process.cwd());
  const maxDepth = Math.max(1, Math.min(3, options.depth ?? 1));
  const maxMatches = options.maxMatches ?? 5;
  const scope = syncGraphIndex(resolved);
  const { index } = scope;
  const search = searchFrontier(resolved, scope, 60);
  const name = symbolQuery.split("#").at(-1) ?? symbolQuery;
  search([name]);
  if (scope.mode === "jit" && !getLookup(index).symbolByName.has(name)) {
    // Partial and case-insensitive matches may occur in the path alone.
    indexSpecificFiles(resolved, scope.knownFiles, { paths: scope.paths });
  }
  let frontierNames = new Set([name]);
  for (let hop = 0; scope.mode === "jit" && hop < maxDepth; hop++) {
    const lookup = getLookup(index);
    const next = new Set<string>();
    for (const key of frontierNames) {
      for (const sym of lookup.symbolByName.get(key) ?? []) for (const call of sym.calls) next.add(call);
      if (hop + 1 < maxDepth) for (const caller of lookup.callersByName.get(key) ?? []) next.add(caller.name);
    }
    if (!search(next)) break;
    frontierNames = next;
  }
  const { symbols, symbolByName: byName, symbolById, callersByName } = getLookup(index);
  const qLower = symbolQuery.toLowerCase();
  const byId = symbolById.get(symbolQuery);
  const exact = byId ? [byId] : byName.get(symbolQuery) ?? [];
  const partial =
    exact.length > 0
      ? exact
      : symbols.filter((s) => s.name.toLowerCase().includes(qLower) || s.id.toLowerCase().includes(qLower));

  return partial.slice(0, maxMatches).map((rootSym) => {
    const callees: SymbolRef[] = [];
    const seenCallees = new Set<string>([rootSym.name]);
    let frontier: CodeSymbol[] = [rootSym];

    for (let hop = 1; hop <= maxDepth; hop++) {
      const nextFrontier: CodeSymbol[] = [];
      for (const node of frontier) {
        for (const callName of node.calls) {
          if (seenCallees.has(callName)) continue;
          seenCallees.add(callName);
          const resolvedTarget = byName.get(callName)?.[0];
          callees.push(
            resolvedTarget
              ? { name: callName, file: resolvedTarget.file, line: resolvedTarget.line, hop }
              : { name: callName, hop }
          );
          if (resolvedTarget) nextFrontier.push(resolvedTarget);
        }
      }
      frontier = nextFrontier;
    }

    const callers: SymbolRef[] = [];
    const seenCallers = new Set<string>([rootSym.id]);
    let callerTargets = new Set<string>([rootSym.name]);

    for (let hop = 1; hop <= maxDepth; hop++) {
      const nextTargets = new Set<string>();
      for (const candidate of [...callerTargets].flatMap(name => callersByName.get(name) ?? [])) {
        if (seenCallers.has(candidate.id)) continue;
        if (candidate.calls.some((c) => callerTargets.has(c))) {
          seenCallers.add(candidate.id);
          callers.push({ name: candidate.name, file: candidate.file, line: candidate.line, hop });
          nextTargets.add(candidate.name);
        }
      }
      callerTargets = nextTargets;
      if (callerTargets.size === 0) break;
    }

    return {
      symbol: rootSym,
      snippet: readBoundedSnippet(resolved, rootSym.file, rootSym.line, rootSym.endLine),
      callees,
      callers
    };
  });
}

/**
 * @gentle-domain graph
 * @gentle-reuse Calcula el radio de impacto (directo y transitivo), tests relacionados y patrones afectados.
 */
export function graphImpact(
  target: string,
  options: { projectRoot?: string } = {}
): ImpactResult {
  const resolved = path.resolve(options.projectRoot ?? process.cwd());
  const scope = syncGraphIndex(resolved);
  const { index } = scope;
  const search = searchFrontier(resolved, scope, 80);
  const isFile = scope.paths.has(target);
  if (scope.mode === "jit" && isFile) indexSpecificFiles(resolved, [target], { paths: scope.paths, followImports: 1 });
  search(isFile ? (index.files[target]?.symbols ?? []).map(s => s.name) : [target.split("#").at(-1) ?? target]);
  const files = scope.knownFiles;
  const guide = loadArchGuide(resolved);
  function traverse() {
    const { importers, symbolById, symbolByName, callersByName } = getLookup(index);
    const byId = symbolById.get(target);
    const roots = byId ? [byId] : index.files[target]?.symbols ?? symbolByName.get(target) ?? [];
    const seen = new Set(roots.map(s => s.id));
    let frontier = roots.length ? roots.map(s => s.name) : [target];
    const directCallers: SymbolRef[] = [];
    const transitiveCallers: SymbolRef[] = [];
    for (let hop = 1; frontier.length; hop++) {
      const next = new Set<string>();
      for (const name of frontier) {
        for (const s of callersByName.get(name) ?? []) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          next.add(s.name);
          (hop === 1 ? directCallers : transitiveCallers).push({ name: s.name, file: s.file, line: s.line, hop });
        }
      }
      frontier = [...next];
    }

    const origins = new Set(roots.map(s => s.file));
    if (Object.hasOwn(index.files, target)) origins.add(target);
    const dependentFiles = new Set([...directCallers, ...transitiveCallers].flatMap(c => c.file ? [c.file] : []));
    const visited = new Set([...origins, ...dependentFiles]);
    for (const file of visited) {
      for (const dependent of importers.get(file) ?? []) {
        visited.add(dependent);
        if (!origins.has(dependent)) dependentFiles.add(dependent);
      }
    }
    const affectedFiles = [...dependentFiles];

    return { origins, affectedFiles, directCallers, transitiveCallers };
  }
  let closure = traverse();
  while (scope.mode === "jit") {
    const terms = [...closure.directCallers, ...closure.transitiveCallers].map(c => c.name);
    for (const file of [...closure.origins, ...closure.affectedFiles]) {
      const stem = path.posix.parse(file).name;
      // Directory imports can resolve to index.ts even via "." or "..".
      terms.push(stem === "index" ? "." : stem);
    }
    if (!search(terms)) break;
    closure = traverse();
  }
  const { origins, affectedFiles, directCallers, transitiveCallers } = closure;
  const stems = [target, ...origins, ...affectedFiles].map((file) => path.basename(file, path.extname(file)).toLowerCase());
  const relatedTests = files.filter(
    (f) =>
      (f.includes("test") || f.includes("spec")) &&
      stems.some((stem) => f.toLowerCase().includes(stem))
  );

  const affectedPatterns = guide.patterns.filter(
    (p) => p.entry.includes(target) || p.files.includes(target) || p.files.some((f) => affectedFiles.includes(f))
  );

  return {
    target,
    directCallers,
    transitiveCallers,
    affectedFiles,
    relatedTests,
    affectedPatterns
  };
}

export function graphRegisterPattern(
  domain: string,
  entry: string,
  guidance: string,
  files: string[] = [],
  projectRoot = process.cwd()
): PatternEntry {
  return registerPattern(path.resolve(projectRoot), domain, entry, guidance, files);
}

export function graphStatus(projectRoot = process.cwd()): GraphStatus {
  const resolved = path.resolve(projectRoot);
  const { index, stats } = syncGraphIndex(resolved, true);
  const guide = loadArchGuide(resolved);
  const totalSymbols = Object.values(index.files).reduce((acc, f) => acc + f.symbols.length, 0);
  return {
    projectRoot: resolved,
    indexedFiles: Object.keys(index.files).length,
    totalSymbols,
    registeredPatterns: guide.patterns.length,
    stalePatterns: stats.stalePatterns,
    updatedAt: index.updatedAt
  };
}
