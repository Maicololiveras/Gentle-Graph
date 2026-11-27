// Git projects candidate paths in one pass. Only actual import declarations in reachable
// modules become file edges, and only bound operations require a full symbol parse.
import fs from "node:fs";
import path from "node:path";
import {resolveImport} from "./languages/registry.ts";
import {indexSpecificFiles, type syncGraphIndex} from "./indexer.ts";
import {symbolNames,saveGraphIndex} from "./store.ts";
import type {CodeSymbol,SymbolRef} from "./types.ts";

export const moduleProjection = Symbol("relative module specifiers");
export const projectionArgs = ["grep","--untracked","-I","-z","-o","-E","-f","-","--",
  ...["ts","tsx","js","jsx","mts","cts","mjs","cjs","svelte"].map(ext=>"*."+ext)];
export const projectionPattern = `["']([.]{1,2}(/[^"']*)?|[$]lib/[^"']*)["']\n`;

export const jsModule=(file:string)=>/\.[cm]?[jt]sx?$/.test(file);

interface Edge {
  file:string;
  dependency:string;
  // Named imports map upstream export to local alias. Re-exports map it to the public alias.
  names:Map<string,string>;
  namespace?:string;
  reexport:boolean;
  star:boolean;
}

// Skip quoted and commented text before considering module declaration keywords.
// The clause may span lines. Side-effect imports contribute a file edge without a symbol.
const declarations = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(import|export)\s*(?:type\s+)?((?:(?:[$\w]+\s*,?\s*)?(?:\{[^}]*\}|\*\s*(?:as\s+[$\w]+)?)?)\s*from\s*)?["']([^"'\r\n]+)["']/g;

function edgesOf(file:string,text:string,paths:Set<string>) {
  const edges:Edge[]=[];
  for(const match of text.matchAll(declarations)){
    if(!match[1])continue;
    const dependency=resolveImport(file,match[3],paths);
    if(!dependency)continue;
    const clause=(match[2]??"").replace(/\s*from\s*$/,"").replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,"").trim();
    const names=new Map<string,string>();
    const named=clause.match(/\{([^}]*)\}/);
    if(named)for(const pair of named[1].split(",")){
      const [upstream,local]=pair.trim().replace(/^type\s+/,"").split(/\s+as\s+/);
      if(upstream)names.set(upstream,local??upstream);
    }
    const def=clause.match(/^([$\w]+)/);
    if(def)names.set("default",def[1]);
    edges.push({file,dependency,names,namespace:clause.match(/\*\s+as\s+([$\w]+)/)?.[1],
      star:clause.startsWith("*"),reexport:match[1]==="export"});
  }
  return edges;
}

type Scope=ReturnType<typeof syncGraphIndex>;
export function moduleImpact(root:string,scope:Scope,roots:CodeSymbol[],rows:string[]|null,deadline:number){
  const candidates=new Map<string,Set<string>>();
  let file=rows?.[0];
  // With -z -o, Git emits path NUL match LF repeatedly. Keep embedded newlines in paths.
  for(let i=1;file && i<rows!.length;i++){
    const sep=rows[i].indexOf("\n");
    if(sep<0)break;
    const end=rows[i][sep-1]==="\r"?sep-1:sep;
    const spec=rows[i].slice(1,end-1);
    if(scope.paths.has(file)){
      const dependency=resolveImport(file,spec,scope.paths);
      if(dependency){
        let files=candidates.get(dependency);
        if(!files)candidates.set(dependency,files=new Set());
        files.add(file);
      }
    }
    file=rows[i].slice(sep+1);
  }
  if(rows===null){
    for(const node of Object.values(scope.index.files)){
      for(const spec of node.imports){
        const dependency=resolveImport(node.path,spec,scope.paths);
        if(!dependency)continue;
        let files=candidates.get(dependency);
        if(!files)candidates.set(dependency,files=new Set());
        files.add(node.path);
      }
    }
  }
  const origins=new Set(roots.map(s=>s.file));
  const reachable=new Set(origins);
  const inbound=new Map<string,Edge[]>();
  const seen=new Set<string>();
  const textByFile=new Map<string,string>();
  for(const dependency of reachable){
    if(performance.now()>=deadline)break;
    for(const file of candidates.get(dependency)??[]){
      if(seen.has(file))continue;
      seen.add(file);
      let text:string;
      try{
        const abs=path.join(root,file),stat=fs.lstatSync(abs);
        if(!stat.isFile() || stat.size>256*1024)continue;
        text=fs.readFileSync(abs,"utf8");
      }catch{continue;}
      for(const edge of edgesOf(file,text,scope.paths)){
        let edges=inbound.get(edge.dependency);
        if(!edges)inbound.set(edge.dependency,edges=[]);
        edges.push(edge);
        if(reachable.has(edge.dependency))reachable.add(file);
      }
      textByFile.set(file,text);
    }
    for(const edge of inbound.get(dependency)??[])reachable.add(edge.file);
  }

  const directCallers:SymbolRef[]=[],transitiveCallers:SymbolRef[]=[];
  const found=new Set(roots.map(s=>s.id));
  const operations=roots.map(symbol=>({symbol,hop:0}));
  // A single impacted exported operation can flow through a cycle of barrels.
  const propagated=new Set<string>();
  function addCallers(file:string,names:Set<string>,hop:number){
    const node=scope.index.files[file];
    for(const symbol of node?.symbols??[]){
      if(found.has(symbol.id) || !symbol.calls.some(c=>names.has(c)))continue;
      found.add(symbol.id);
      operations.push({symbol,hop});
      (hop===1?directCallers:transitiveCallers).push({file,name:symbol.name,line:symbol.line,hop});
    }
  }
  const changed=new Set<string>();
  const parsed=new Set<string>();
  const localExports=new Map<string,Map<string,string[]>>();
  function exportedAs(file:string,local:string){
    let names=localExports.get(file);
    if(!names){
      let text=textByFile.get(file);
      if(text===undefined){
        try{text=fs.readFileSync(path.join(root,file),"utf8");}catch{text="";}
      }
      names=new Map();
      const add=(local:string,out:string)=>names.set(local,[...(names.get(local)??[]),out]);
      const lists=/\bexport\s*\{([^}]*)\}(?!\s*from\b)|\bexport\s+default\s+([$\w]+)\s*(?:;|$)/gm;
      for(const match of text.matchAll(lists)){
        if(match[2]){add(match[2],"default");continue;}
        for(const item of match[1].split(",")){
          const [source,out]=item.trim().split(/\s+as\s+/);
          if(source)add(source,out??source);
        }
      }
      localExports.set(file,names);
    }
    return names.get(local)??[];
  }
  const invocations=new Map<string,RegExp>();
  function hasInvocation(file:string,name:string){
    let re=invocations.get(name);
    if(!re){
      // Generic arguments can nest. A '<' leaves the candidate for the real parser.
      re=new RegExp("(?:^|[^\\w$])"+name.replace(/[$]/g,"\\$&")+"\\s*(?:\\?\\.\\s*)?(?:[<(]|/\\*|//)");
      invocations.set(name,re);
    }
    return re.test(textByFile.get(file)??"");
  }
  for(const {symbol,hop} of operations){
    if(performance.now()>=deadline)break;
    addCallers(symbol.file,new Set(symbolNames(symbol.name)),hop+1);

    const member=symbol.kind==="method"? symbol.name.split(".").at(-1):undefined;
    const name=member?symbol.name.split(".")[0]:symbol.name;
    const forwards=exportedAs(symbol.file,name).map(alias=>({file:symbol.file,name:alias}));
    if(symbol.exported)forwards.push({file:symbol.file,name});
    if(/\bexport\s+default\b/.test(symbol.signature))forwards.push({file:symbol.file,name:"default"});
    for(const current of forwards){
      const key=JSON.stringify([current.file,current.name,member]);
      if(propagated.has(key))continue;
      propagated.add(key);
      for(const edge of inbound.get(current.file)??[]){
        const alias=edge.names.get(current.name);
        if(edge.reexport){
          if(alias || edge.star && current.name!=="default")forwards.push({file:edge.file,name:alias??current.name});
          continue;
        }
        if(!alias && !edge.namespace)continue;
        if(alias)for(const out of exportedAs(edge.file,alias))forwards.push({file:edge.file,name:out});
        const call=member??alias??current.name;
        if(!hasInvocation(edge.file,call))continue;
        if(!parsed.has(edge.file)){
          parsed.add(edge.file);
          indexSpecificFiles(root,[edge.file],{paths:scope.paths,deadline,deferSave:changed});
        }
        addCallers(edge.file,new Set([call]),hop+1);
      }
    }
  }
  if(changed.size){
    try{saveGraphIndex(root,scope.index,changed);}catch{ /* Read-only projects retain the session index. */ }
  }
  return {origins,affectedFiles:[...reachable].filter(file=>!origins.has(file)),
    directCallers,transitiveCallers,contracts:[] as string[]};
}

// Git can return hundreds of call sites, comments or test strings for a unique
// declaration. Identify likely JS declaration files before invoking a parser.
export function possibleModuleDefinitions(root:string,hits:string[],symbol:string){
  if(!/^[$\w]+$/.test(symbol))return [];
  const name=symbol.replace(/[$]/g,"\\$&");
  const declaration=new RegExp("\\b(?:function\\s*\\*?\\s*|(?:class|interface|type|const|var|let)\\s+)"+name+"(?![\\w$])");
  return hits.filter(file=>{
    if(!jsModule(file))return true;
    try{
      const abs=path.join(root,file);
      const stat=fs.lstatSync(abs);
      return stat.isFile() && stat.size<=256*1024 && declaration.test(fs.readFileSync(abs,"utf8"));
    }catch{return false;}
  });
}
