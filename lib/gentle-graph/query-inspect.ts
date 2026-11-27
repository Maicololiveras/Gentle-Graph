import {GitScopeError} from "./git-scope.ts";
import path from "node:path";
import { getLookup,loadArchGuide,symbolNames } from "./store.ts";
import { isTestFile,resolveImport } from "./languages/registry.ts";
import { indexSpecificFiles,syncGraphIndex,cachedScope } from "./indexer.ts";
import {bindingMatches,readBoundedSnippet,searchFrontier,runSync,type QuerySteps} from "./query-shared.ts";
import type {CodeSymbol,InspectResult,SymbolRef} from "./types.ts";
/**
 * @gentle-domain graph
 * @gentle-reuse Inspecciona firma, código acotado, callees y callers de un símbolo hasta depth saltos.
 */
export function graphInspect(symbolQuery:string, options:{projectRoot?: string; depth?: number; maxMatches?: number}={}):InspectResult[] {
  const root=path.resolve(options.projectRoot??process.cwd());
  try{return runSync(root,inspectSteps(symbolQuery,options,root,syncGraphIndex(root)));}
  catch(error){if(!(error instanceof GitScopeError))throw error;return runSync(root,inspectSteps(symbolQuery,options,root,cachedScope(root)));}
}
export function* inspectSteps(symbolQuery:string, options:{projectRoot?: string; depth?: number; maxMatches?: number},resolved:string,scope:ReturnType<typeof syncGraphIndex>):QuerySteps<InspectResult[]> {
  const maxDepth = Math.max(1, Math.min(3, options.depth ?? 1));
  const maxMatches = options.maxMatches ?? 5;
  const { index } = scope;
  const search = searchFrontier(resolved, scope);
  const name = symbolQuery.split("#").at(-1) ?? symbolQuery;
  yield* search([name]);
  if (scope.mode === "jit" && !getLookup(index).symbolByName.has(name)) {
    // Partial and case-insensitive matches may occur in the path alone.
    indexSpecificFiles(resolved, scope.knownFiles, { paths: scope.paths });
  }
  // A receiver may be a local instance of a directly imported class.
  if(scope.mode==="jit"){
    const roots=getLookup(index).symbolByName.get(name)??[];
    for(const file of new Set(roots.map(s=>s.file))){
      if(/\.[cm]?[jt]sx?$/.test(file))indexSpecificFiles(resolved,[file],{paths:scope.paths,followImports:1});
    }
  }
  let frontierNames = new Set([name]);
  for (let hop = 0; scope.mode === "jit" && hop < maxDepth; hop++) {
    const lookup = getLookup(index);
    const next = new Set<string>();
    for (const key of frontierNames) {
      for (const sym of lookup.symbolByName.get(key) ?? []) for (const call of sym.importCallees??sym.calls) next.add(call);
      if (hop + 1 < maxDepth) for (const caller of lookup.callersByName.get(key) ?? []) next.add(caller.name);
    }
    if (!(yield* search(next))) break;
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
    const evidence: NonNullable<InspectResult["evidence"]> = (rootSym.sites ?? [])
      .filter(s => s.role === "Execute" || s.role === "CanExecute")
      .map(site => ({ ...site, file: rootSym.file }));
    const collectSites = (target: CodeSymbol, roles: string[], via?: string[]) => {
      const keys = new Set(symbolNames(target.name));
      const candidates = new Set([...keys].flatMap(key => callersByName.get(key) ?? []));
      for (const caller of candidates) {
        if (!bindingMatches(index, caller, target)) continue;
        for (const site of caller.sites ?? []) {
          if (!roles.includes(site.role) || !keys.has(site.target)) continue;
          if (site.role === "Test call" && (site.qualified !== target.name || byName.get(target.name)?.length !== 1)) continue;
          evidence.push({ ...site, file: caller.file, via });
        }
      }
    };
    collectSites(rootSym, ["Binding", "Test call"]);
    const callees: SymbolRef[] = [];
    const seenCallees = new Set<string>([rootSym.name]);
    const routes = new Map<string, string[]>([[rootSym.id, [rootSym.name]]]);
    let frontier: CodeSymbol[] = [rootSym];

    for (let hop = 1; hop <= maxDepth; hop++) {
      const nextFrontier: CodeSymbol[] = [];
      for (const node of frontier) {
        for (const callName of node.calls) {
          if (seenCallees.has(callName)) continue;
          seenCallees.add(callName);
          const qualified = node.qualifiedCalls?.filter(ref => ref.endsWith("." + callName));
          const key = qualified === undefined ? callName : qualified.length === 1 ? qualified[0] : undefined;
          const candidates = key ? byName.get(key) : undefined;
          const nearby = () => {
            const imports=new Set(index.files[node.file].imports.map(spec=>resolveImport(node.file,spec,scope.paths)));
            return candidates?.filter(c=>c.kind==="method" && (c.file===node.file || imports.has(c.file)));
          };
          const possible = node.localCallees?.includes(callName) ? candidates?.filter(c=>c.file===node.file)
            : node.importCallees && !node.importCallees.includes(callName) ? nearby() : candidates;
          const resolvedTarget = possible?.length === 1 ? possible[0] : undefined;
          callees.push(
            resolvedTarget
              ? { name: callName, file: resolvedTarget.file, line: resolvedTarget.line, hop }
              : { name: callName, hop }
          );
          if (resolvedTarget) {
            nextFrontier.push(resolvedTarget);
            if (rootSym.sites?.some(s => s.role === "Execute")) {
              const via = routes.get(node.id)!;
              routes.set(resolvedTarget.id, [...via, resolvedTarget.name]);
              collectSites(resolvedTarget, ["Test call"], via);
            }
          }
        }
      }
      frontier = nextFrontier;
    }

    const callers: SymbolRef[] = [];
    const seenCallers = new Set<string>([rootSym.id]);
    let previous = [rootSym];
    let callerTargets = new Set<string>(symbolNames(rootSym.name));

    for (let hop = 1; hop <= maxDepth; hop++) {
      const nextTargets = new Set<string>();
      const found: CodeSymbol[] = [];
      for (const candidate of [...callerTargets].flatMap(name => callersByName.get(name) ?? [])) {
        if (seenCallers.has(candidate.id)) continue;
        if (candidate.file.endsWith(".xaml") && !previous.some(t => candidate.calls.some(name => symbolNames(t.name).includes(name)) && bindingMatches(index, candidate, t))) continue;
        if (candidate.qualifiedCalls && isTestFile(candidate.file) &&
            !candidate.qualifiedCalls.some(ref => callerTargets.has(ref) && byName.get(ref)?.length === 1)) continue;
        if (candidate.calls.some((c) => callerTargets.has(c))) {
          seenCallers.add(candidate.id);
          found.push(candidate);
          const site = candidate.sites?.find(s => callerTargets.has(s.qualified ?? s.target));
          callers.push({ name: candidate.name, file: candidate.file, line: site?.line ?? candidate.line, hop });
          for (const key of symbolNames(candidate.name)) nextTargets.add(key);
        }
      }
      previous = found;
      callerTargets = nextTargets;
      if (callerTargets.size === 0) break;
    }

    const implementations: SymbolRef[] = [];
    if (["interface","class","struct","trait","record"].includes(rootSym.kind)) {
      const language = index.files[rootSym.file].language;
      const peers = (byName.get(rootSym.name) ?? []).filter(s => s.kind === rootSym.kind && index.files[s.file].language === language);
      for (const candidate of getLookup(index).implementationsByContract.get(rootSym.name) ?? []) {
        if (index.files[candidate.file].language !== language) continue;
        // An unqualified base name alone cannot attribute a homonymous contract.
        if (peers.length !== 1) continue;
        implementations.push({ name: candidate.implementationName ?? candidate.name, file: candidate.file, line: candidate.line, hop: 1 });
      }
    }
    return {
      ...(exact.length > 1 && !byId ? { alternatives: exact.map(s => s.id) } : {}),
      evidence,
      implementations,
      symbol: rootSym,
      snippet: readBoundedSnippet(resolved, rootSym.file, rootSym.line, rootSym.endLine),
      callees,
      callers
    };
  });
}
