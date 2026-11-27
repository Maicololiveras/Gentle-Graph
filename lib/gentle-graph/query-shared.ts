import {moduleProjection,projectionArgs,projectionPattern} from "./impact-modules.ts";
import fs from "node:fs";
import path from "node:path";
import type { GraphIndex, CodeSymbol } from "./types.ts";
import {getLookup,symbolNames} from "./store.ts";
import {gitGrepFiles,gitGrepFilesSync,gitPaths,gitPathsSync,type GitSnapshot} from "./git-scope.ts";
import {indexSpecificFiles,syncGraphIndex} from "./indexer.ts";
export function bindingMatches(index: GraphIndex, view: CodeSymbol, target: CodeSymbol) {
  if (!view.file.endsWith(".xaml") || target.kind !== "property") return true;
  const owners = getLookup(index).symbolByName.get(target.name)?.filter(s => s.kind === "property") ?? [];
  const contexts = index.files[view.file + ".cs"]?.dataContexts ?? [];
  if (!contexts.length) return owners.length === 1;
  const containsContext = (s: CodeSymbol) => index.files[s.file]?.symbols.some(type =>
    type.kind === "class" && contexts.includes(type.name) && type.line <= s.line && type.endLine >= s.line);
  return owners.filter(containsContext).length === 1 && containsContext(target);
}

export function readBoundedSnippet(projectRoot: string, relFile: string, startLine: number, endLine: number, maxLines = 25): string {
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

// Collect unique paths once per frontier. A failed Git search falls back
// to the full delta so it cannot silently hide callers.
export function searchFrontier(root: string, scope: ReturnType<typeof syncGraphIndex>, deadline=Infinity) {
  const searched = new Set<string>();
  let complete = scope.mode === "full";
  return function* (terms: Iterable<string>, paths: Iterable<string> = []):Generator<string[],boolean,string[]|null> {
    if (complete) return false;
    const literals = new Set<string>(paths);
    for (const term of terms) {
      for (const name of symbolNames(term)) {
        literals.add(name);
        if (name.endsWith("Command")) literals.add(name.slice(0, -7));
        if (/^[A-Z]/.test(name)) literals.add(name[0].toLowerCase() + name.slice(1));
      }
    }
    const pending = [...literals].filter(term => term && !searched.has(term));
    if (!pending.length) return false;
    for (const term of pending) searched.add(term);
    // git reads literals on stdin, so large frontiers also fit the Windows command-line limit.
    const hits = yield pending;
    if(performance.now()>=deadline)return false;
    if (!hits) {
      indexSpecificFiles(root, scope.knownFiles, { paths: scope.paths, deadline });
      complete = true;
    } else if (hits.length) indexSpecificFiles(root, hits, { paths: scope.paths, followImports: hits.some(f=>f.endsWith(".xaml"))?1:0,deadline });
    return true;
  };
}


export type QuerySteps<T> = Generator<string[]|typeof moduleProjection,T,string[]|null>;
export function runSync<T>(root:string, steps:QuerySteps<T>,deadline=Infinity):T {
  let step=steps.next();
  while(!step.done){
    const remaining=Math.min(4000,Math.ceil(deadline-performance.now()));
    const rows=remaining<=0?null:step.value===moduleProjection
      ?gitPathsSync(root,projectionArgs,true,projectionPattern,remaining)
      :gitGrepFilesSync(root,step.value as string[],Infinity,remaining);
    step=steps.next(rows);
  }
  return step.value;
}
const projections=new WeakMap<GitSnapshot,string[]>();
export async function runAsync<T>(root:string,steps:QuerySteps<T>,state:GitSnapshot|null,deadline=Infinity):Promise<T>{
  let step=steps.next();
  while(!step.done){
    const remaining=deadline-performance.now();
    if(step.value===moduleProjection && remaining>0){
      const rows=(state && projections.get(state))??await gitPaths(root,projectionArgs,projectionPattern,Math.min(4000,Math.ceil(remaining)));
      if(state && rows)projections.set(state,rows);
      step=steps.next(rows);
      continue;
    }
    step=steps.next(remaining<=0?null:await gitGrepFiles(root,step.value as string[],Infinity,state,Math.max(1,Math.min(4000,Math.ceil(remaining)))));
  }
  return step.value;
}
