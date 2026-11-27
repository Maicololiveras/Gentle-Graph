import path from "node:path";
import { getLookup,loadArchGuide,symbolNames } from "./store.ts";
import { isTestFile } from "./languages/registry.ts";
import { indexSpecificFiles,syncGraphIndex } from "./indexer.ts";
import fs from "node:fs";
import {bindingMatches,searchFrontier,runSync,type QuerySteps} from "./query-shared.ts";
import type {CodeSymbol,ImpactResult,SymbolRef} from "./types.ts";
/**
 * @gentle-domain graph
 * @gentle-reuse Calcula el radio de impacto (directo y transitivo), tests relacionados y patrones afectados.
 */
export function graphImpact(target:string, options:{projectRoot?: string; budgetMs?:number}={}):ImpactResult {
  const root=path.resolve(options.projectRoot??process.cwd());
  const deadline=performance.now()+Math.min(1500,Math.max(0,options.budgetMs??1500));
  return runSync(root,impactSteps(target,options,root,syncGraphIndex(root),deadline),deadline);
}
export function* impactSteps(target:string, options:{projectRoot?: string; budgetMs?:number},resolved:string,scope:ReturnType<typeof syncGraphIndex>, deadline:number,checkpoint?:(partial:ImpactResult)=>void):QuerySteps<ImpactResult> {
  const { index } = scope;
  const search = searchFrontier(resolved, scope,deadline);
  const isFile = scope.paths.has(target);
  if (scope.mode === "jit" && isFile) indexSpecificFiles(resolved, [target], { paths: scope.paths, followImports: 1 });
  yield* search(isFile ? (index.files[target]?.symbols ?? []).map(s => s.name) : [target.split("#").at(-1) ?? target]);
  const files = scope.knownFiles;
  const live = new Map<string, boolean>();
  function exists(file: string) {
    if (!live.has(file)) {
      try { live.set(file, fs.lstatSync(path.join(resolved, file)).isFile()); }
      catch { live.set(file, false); }
    }
    return live.get(file)!;
  }
  const alternatives = isFile ? [] : (getLookup(index).symbolByName.get(target) ?? []).filter(s => s.kind === "property" && exists(s.file));
  if (alternatives.length > 1) return { target, alternatives: alternatives.map(s => s.id),
    directCallers: [], transitiveCallers: [], affectedFiles: [], relatedTests: [], affectedPatterns: [] };
  const guide = loadArchGuide(resolved);
  function traverse() {
    const { importers, symbolById, symbolByName, callersByName } = getLookup(index);
    const byId = symbolById.get(target);
    const roots = byId ? [byId] : index.files[target]?.symbols ?? symbolByName.get(target) ?? [];
    const seen = new Set(roots.map(s => s.id));
    let frontier = roots.length ? roots.flatMap(s => [...symbolNames(s.name), ...(s.contracts ?? [])]) : [target];
    const directCallers: SymbolRef[] = [];
    const transitiveCallers: SymbolRef[] = [];
    let previous = roots;
    for (let hop = 1; frontier.length && performance.now()<deadline; hop++) {
      const found: CodeSymbol[] = [];
      const next = new Set<string>();
      for (const name of frontier) {
        for (const s of callersByName.get(name) ?? []) {
          if (seen.has(s.id) || !exists(s.file)) continue;
          if (s.file.endsWith(".xaml") && !previous.filter(t => symbolNames(t.name).includes(name)).some(t => bindingMatches(index, s, t))) continue;
          if (s.qualifiedCalls && isTestFile(s.file) && !previous.some(t => s.qualifiedCalls!.includes(t.name) && symbolByName.get(t.name)?.length === 1)) continue;
          found.push(s);
          seen.add(s.id);
          for (const key of symbolNames(s.name)) next.add(key);
          (hop === 1 ? directCallers : transitiveCallers).push({ name: s.name, file: s.file, line: s.line, hop });
        }
      }
      previous = found;
      frontier = [...next];
    }

    const origins = new Set(roots.map(s => s.file));
    if (Object.hasOwn(index.files, target)) origins.add(target);
    const dependentFiles = new Set([...directCallers, ...transitiveCallers].flatMap(c => c.file ? [c.file] : []));
    for (const s of roots) if (s.kind === "property") dependentFiles.add(s.file);
    const visited = new Set([...origins, ...dependentFiles]);
    for (const file of visited) {
      for (const dependent of importers.get(file) ?? []) {
        if (!exists(dependent)) continue;
        visited.add(dependent);
        if (!origins.has(dependent)) dependentFiles.add(dependent);
      }
    }
    const affectedFiles = [...dependentFiles];

    return { origins, affectedFiles, directCallers, transitiveCallers, contracts: roots.flatMap(s => s.contracts ?? []) };
  }
  let closure = traverse();
  if(checkpoint) checkpoint({target,...closure,partial:true,relatedTests:closure.affectedFiles.filter(isTestFile),affectedPatterns:[]});
  while (scope.mode === "jit" && performance.now()<deadline) {
    const terms = [...closure.directCallers, ...closure.transitiveCallers].map(c => c.name);
    terms.push(...closure.contracts);
    const paths: string[] = [];
    for (const file of [...closure.origins, ...closure.affectedFiles]) {
      const stem = path.posix.parse(file).name;
      // Directory imports can resolve to index.ts even via "." or "..".
      paths.push(stem === "index" ? "." : stem);
    }
    if (!(yield* search(terms,paths))) break;
    closure = traverse();
  }
  const { origins, affectedFiles, directCallers, transitiveCallers } = closure;
  // .Tests projects can contain helpers, GlobalUsings and build metadata.
  const testSource = (file: string) => isTestFile(file) && (!file.toLowerCase().endsWith(".cs")
    || /Tests?\.cs$/i.test(file)
    || index.files[file]?.symbols.some(s => s.kind === "method" && /\[(?:Test|Fact|Theory|TestCase|TestMethod)\b/.test(s.signature)));
  const dependencyTests = affectedFiles.filter(testSource);
  const stem = (file: string) => path.posix.parse(file).name.toLowerCase();
  const stems = new Set([...origins, ...affectedFiles.filter(f => !isTestFile(f))].map(stem));
  const namedTests = files.filter(file => {
    if (!testSource(file)) return false;
    const subject = stem(file).replace(/^test_/, "").replace(/(?:[._-]?(?:tests?|spec))$/, "");
    return stems.has(subject) && exists(file);
  });
  const relatedTests = [...new Set([...dependencyTests, ...namedTests])];
  const affectedPatterns = guide.patterns.filter(
    (p) => p.entry.includes(target) || p.files.includes(target) || p.files.some((f) => affectedFiles.includes(f))
  );

  return {
    target,
    ...(performance.now()>=deadline?{partial:true}:{}),
    directCallers,
    transitiveCallers,
    affectedFiles,
    relatedTests,
    dependencyTests,
    namedTests: namedTests.filter(file => !dependencyTests.includes(file)),
    affectedPatterns
  };
}
