import path from "node:path";
import fs from "node:fs";
import { detectArchitecture } from "./arch-detector.ts";
import { rankModules, recommendPath, tokenizeIntent, isFixturePath } from "./arch-guide.ts";
import { graphInspect } from "./query-inspect.ts";
import { getLookup,loadArchGuide,searchIndexedFiles } from "./store.ts";
import { isTestFile } from "./languages/registry.ts";
import { indexSpecificFiles, syncGraphIndex } from "./indexer.ts";
import type { GuideRecommendation, CodeSymbol } from "./types.ts";
/**
 * @gentle-domain graph
 * @gentle-reuse Punto de entrada principal para guiar al agente antes de crear archivos o abstracciones nuevas.
 */
export function graphGuide(
  intent: string,
  options: { projectRoot?: string; limit?: number; includeSnippets?: boolean } = {}
): GuideRecommendation {
  const resolved = path.resolve(options.projectRoot ?? process.cwd());
  return guideFromScope(intent,options,resolved,syncGraphIndex(resolved));
}
export function guideFromScope(intent:string,options:{limit?:number;includeSnippets?:boolean},resolved:string,scope:ReturnType<typeof syncGraphIndex>){
  const { index } = scope;
  const words = tokenizeIntent(intent);
  const rules = loadArchGuide(resolved);
  if (scope.mode === "jit") {
    const tokens = words.includes("configuration") ? [...words, "config"] : words;
    const patterns = rules.patterns;
    const referenced = new Set(patterns.flatMap(p => [p.entry.split("#")[0], ...p.files]));
    const dirty = new Set(scope.dirty);
    const matches=new Set(searchIndexedFiles(resolved,intent));
    const ranked: { file: string; score: number }[] = [];
    for (const file of scope.knownFiles) {
      const name = file.toLowerCase();
      let score = Number(matches.has(file))*4 + Number(referenced.size > 0 && referenced.has(file)) + Number(dirty.size > 0 && dirty.has(file));
      for (const token of tokens) if (name.includes(token)) score += 4;
      if (!score || (ranked.length === 15 && score <= ranked[14].score)) continue;
      const pos = ranked.findIndex(item => item.score < score);
      ranked.splice(pos < 0 ? ranked.length : pos, 0, { file, score });
      if (ranked.length > 15) ranked.pop();
    }
    indexSpecificFiles(resolved, ranked.map(row => row.file), {paths:scope.paths,preview:true});
    const seeds=rankModules(index,words,3);
    indexSpecificFiles(resolved,seeds.map(m=>m.file),{paths:scope.paths,followImports:1,preview:true});
  }
  const guide = recommendPath(resolved, index, intent, options.limit ?? 5, rules);
  const signals = new Set<string>();
  for (const node of Object.values(index.files)) {
    if (node.language === "swift" && node.imports.includes("SwiftUI")) signals.add("SwiftUI");
    if (node.language === "java" && node.symbols.some(s=>["RestController","Service","Repository"].includes(s.domainTag))) signals.add("Spring Boot");
    if (node.language !== "csharp") continue;
    if (node.dataContexts?.some(type => /(?:VM|ViewModel)$/.test(type))) signals.add("MVVM");
    for (const symbol of node.symbols) {
      if (/^Add(?:Scoped|Singleton|Transient)</.test(symbol.name)) signals.add("DI");
      if (symbol.contracts?.some(c => /^(?:IRequestHandler|INotificationHandler)$/.test(c))) signals.add("CQRS");
    }
  }
  const profile = detectArchitecture(resolved, scope.knownFiles, scope.manifests, [...signals].sort());
  const labels = profile.architectures.join(" + ");
  if (labels || profile.frameworks.length) {
    guide.architecture = [labels, profile.frameworks.length ? "(" + profile.frameworks.join(", ") + ")" : ""].filter(Boolean).join(" ");
    if (profile.layers.length > 1) guide.architecture += " | layers: " + profile.layers.join(", ");
  }
  const manual = [rules.boundaries, rules.rules].flatMap(items => Array.isArray(items) ? items.filter(rule => typeof rule === "string") : []);
  const eligible = scope.contracts.filter(f=>!isFixturePath(f));
  const contracts = eligible.length === 1 ? eligible : eligible.filter(f=>tokenizeIntent(path.posix.basename(f)).some(t=>words.includes(t)));
  if (contracts.length) manual.push("Consultar "+contracts.slice(0,2).join(", "));
  const explicit = manual.length || guide.matchingPatterns.length || guide.recommendedModules.some(m => m.boundaries.length);
  guide.boundaries = (explicit ? manual : profile.boundaries).filter(line=>!isFixturePath(line));
  if (!explicit) {
    const slice = profile.slices.find(s => words.some(t => path.posix.basename(s).toLowerCase().includes(t)));
    if (slice) {
      guide.slice = "Ubica el caso de uso en " + slice;
      guide.suggestedPath.unshift(guide.slice);
    }
  }
  const entry=index.files[guide.recommendedModules[0]?.file];
  const entryCalls=new Set(entry?.symbols.flatMap(s=>s.calls));
  const lookup=getLookup(index);
  const neighborExports = new Set(guide.recommendedModules.slice(1,3).flatMap(m=>index.files[m.file].exports));
  const top = guide.recommendedModules.slice(0, 3);
  const missingTests = new Set(top.map(module => path.posix.parse(module.file).name));
  const testByStem = new Map<string, string>();
  // Only the three displayed modules need a convention-based test candidate.
  for (const file of scope.tests) {
    if (!missingTests.size) break;
    const start = file.lastIndexOf("/") + 1;
    for (const stem of missingTests) {
      if (!file.startsWith(stem, start)) continue;
      if (path.posix.parse(file).name.replace(/(?:[._-](?:test|spec))$/i, "") !== stem) continue;
      testByStem.set(stem, file);
      missingTests.delete(stem);
      break;
    }
  }
  for (const module of top) {
    const node=index.files[module.file];
    const operations=node.symbols.filter(s=>s.exported && (s.kind==="function" || s.kind==="method" || s.kind==="const"));
    const score=(s:CodeSymbol)=> (module.file===entry?.path && s.calls.some(c=>neighborExports.has(c))?12:0)+(entryCalls.has(s.name)?6:0)+words.filter(w=>s.name.toLowerCase().includes(w)).length*2
      +Number(s.calls.length>0);
    const symbol=operations.sort((a,b)=>score(b)-score(a))[0] ?? node.symbols[0];
    if (!symbol) continue;
    module.coordinate=symbol.name+" L"+symbol.line+"-"+symbol.endLine;
    const callers=lookup.callersByName.get(symbol.name)??[];
    const caller=callers.find(s=>s.file===entry?.path && s.file!==module.file) ?? callers.find(s=>s.file!==module.file);
    if(caller && lookup.symbolByName.get(symbol.name)?.length===1){
      try {
        const lines=fs.readFileSync(path.join(resolved,caller.file),"utf8").split(/\r?\n/);
        const name=symbol.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        const call=new RegExp("\\b"+name+"\\s*\\(");
        for(let line=caller.line;line<=caller.endLine;line++) if(call.test(lines[line-1]??"")){
          module.caller=caller.file+":"+line;break;
        }
      } catch { /* A concurrent edit may remove the caller. */ }
    }
    const stem=path.posix.parse(module.file).name;
    module.associatedTest=callers.find(s=>isTestFile(s.file))?.file ??
      testByStem.get(stem);
  }
  if (options.includeSnippets) {
    const tokens = tokenizeIntent(intent);
    const candidates = guide.recommendedModules.flatMap(module => index.files[module.file]?.symbols ?? []);
    const score = (s: CodeSymbol) => Number(s.exported) + 4 * tokens.filter(t => s.name.toLowerCase().includes(t)).length;
    const selected = candidates.sort((a,b) => score(b)-score(a)).slice(0,3);
    guide.subgraph = selected.flatMap(s => graphInspect(s.id, {projectRoot:resolved, maxMatches:1}));
  }
  return guide;
}
