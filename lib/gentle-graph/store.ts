import { resolveImport } from "./languages/registry.ts";
import {existingBackend,sqliteBackend,SQL_FILE_THRESHOLD} from "./sqlite-backend.ts";
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


export function symbolNames(name: string): string[] {
  const short = name.split(/::|\./).at(-1)!;
  return name === short ? [name] : [name, short];
}

type NodeEntry=GraphIndex["files"][string];
class LookupState {
  entries=new Map<string,NodeEntry>();
  order=new Map<string,number>();
  next=0;
  watched=new Map<string,Set<string>>();
  probes=new Map<string,Set<string>>();
  targets=new Map<string,Set<string>>();
  flat?:CodeSymbol[];
  lookup:GraphLookup;
  constructor(){
    const state=this;
    this.lookup={get symbols(){return state.flat??=Array.from(state.entries.values()).flatMap(f=>f.symbols);},
      implementationsByContract:new Map(),importers:new Map(),symbolByName:new Map(),symbolById:new Map(),callersByName:new Map()};
  }
  symbols(file:NodeEntry,remove:boolean){
    const l=this.lookup;
    const update=(map:Map<string,CodeSymbol[]>,key:string,s:CodeSymbol)=>{
      const group=map.get(key);
      if(remove){if(group){const pos=group.indexOf(s);if(pos>=0)group.splice(pos,1);if(!group.length)map.delete(key);}return;}
      if(!group){map.set(key,[s]);return;}
      const rank=this.order.get(file.path);
      if(this.order.get(group.at(-1).file)<=rank){group.push(s);return;}
      group.splice(group.findIndex(x=>this.order.get(x.file)>rank),0,s);
    };
    for(const s of file.symbols){
      if(remove)l.symbolById.delete(s.id);else l.symbolById.set(s.id,s);
      for(const key of symbolNames(s.name))update(l.symbolByName,key,s);
      for(const key of s.calls)update(l.callersByName,key,s);
      for(const key of new Set(s.contracts))update(l.implementationsByContract,key,s);
    }
  }
  imports(index:GraphIndex,file:string){
    const drop=(map:Map<string,Set<string>>,keys?:Set<string>)=>{
      for(const key of keys??[]){const set=map.get(key);set?.delete(file);if(!set?.size)map.delete(key);}
    };
    const attach=(map:Map<string,Set<string>>,key:string)=>{
      let set=map.get(key);if(!set)map.set(key,set=new Set());set.add(file);
    };
    drop(this.watched,this.probes.get(file));drop(this.lookup.importers,this.targets.get(file));
    this.probes.delete(file);this.targets.delete(file);
    const node=this.entries.get(file);
    if(!node?.imports.length)return;
    const probes=new Set<string>(),targets=new Set<string>();
    // Adapters resolve using membership tests. Track failed probes as well,
    // so a newly created higher-priority module changes existing import edges.
    const paths={has:(p:string)=>{probes.add(p);return Object.hasOwn(index.files,p);}} as Set<string>;
    for(const spec of node.imports){const hit=resolveImport(file,spec,paths);if(hit)targets.add(hit);}
    for(const p of probes)attach(this.watched,p);
    for(const p of targets)attach(this.lookup.importers,p);
    this.probes.set(file,probes);this.targets.set(file,targets);
  }
}
const states=new WeakMap<GraphIndex,LookupState>();
export function patchLookup(index:GraphIndex,changedPaths:Iterable<string>,removedPaths:Iterable<string>=[]){
  const state=states.get(index);if(!state)return;
  const touched=new Set([...changedPaths,...removedPaths]),importers=new Set(touched);
  for(const file of touched){
    const old=state.entries.get(file),node=index.files[file];
    if(!old || !node)for(const ref of state.watched.get(file)??[])importers.add(ref);
    if(old)state.symbols(old,true);
    if(node){
      if(!state.order.has(file))state.order.set(file,state.next++);
      state.entries.set(file,node);state.symbols(node,false);
    }else{state.entries.delete(file);state.order.delete(file);}
  }
  state.flat=undefined;
  for(const file of importers)state.imports(index,file);
}
export function getLookup(index:GraphIndex):GraphLookup{
  let state=states.get(index);
  if(!state){state=new LookupState();states.set(index,state);patchLookup(index,Object.keys(index.files));}
  return state.lookup;
}
export function invalidateLookup(index:GraphIndex){states.delete(index);}

function ensureGraphDir(projectRoot: string): string {
  const dir = path.join(projectRoot, GRAPH_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function writeAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, path.basename(filePath) === GUIDE_FILE ? 2 : undefined), "utf8");
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

const stamps = new Map<string,string>();
export function clearMemoryCache(projectRoot?:string){
  const root=projectRoot ? path.resolve(projectRoot) : undefined;
  if(root){memoryIndexCache.delete(root);stamps.delete(root);}
  else{memoryIndexCache.clear();stamps.clear();}
  existingBackend()?.closeSql(root);
}
export function jsonOnly(root:string){
  return process.env.GENTLE_GRAPH_STORE==="json" || /^(?:\\\\|\/\/)/.test(root);
}
function hasSql(root:string){
  return !jsonOnly(root) && fs.existsSync(path.join(root,GRAPH_DIR,"index.sqlite"));
}
export function searchIndexedFiles(root:string,intent:string,limit=15){
  return hasSql(root)?sqliteBackend().searchSqlFiles(root,intent,limit):undefined;
}
function jsonStamp(file:string){
  const stat=fs.statSync(file,{bigint:true,throwIfNoEntry:false});
  return stat ? "json:"+stat.mtimeNs+":"+stat.size+":"+stat.ino : "absent";
}
export function indexStamp(root:string){
  return hasSql(root)?"sql:"+sqliteBackend().sqlVersion(root):jsonStamp(path.join(root,GRAPH_DIR,INDEX_FILE));
}
export function loadGraphIndex(projectRoot:string):GraphIndex{
  const root=path.resolve(projectRoot);
  const stamp=indexStamp(root);
  const cached=memoryIndexCache.get(root);
  if(cached && stamps.get(root)===stamp)return cached;
  if(cached && stamp.startsWith("sql:") && stamps.get(root)?.startsWith("sql:")){
    const changed=sqliteBackend().refreshSqlIndex(root,cached);
    if(changed){patchLookup(cached,changed);stamps.set(root,stamp);return cached;}
  }
  let index:GraphIndex;
  if(stamp.startsWith("sql:"))index=sqliteBackend().readSqlIndex(root);
  else if(stamp!=="absent"){
    try{const data=JSON.parse(fs.readFileSync(path.join(root,GRAPH_DIR,INDEX_FILE),"utf8"));if(data.version===8 && data.files)index=data;}
    catch{/* Rebuild an unreadable JSON cache on the next query. */}
  }
  index??={version:8,projectRoot:root,updatedAt:new Date(0).toISOString(),files:{}};
  memoryIndexCache.set(root,index);stamps.set(root,stamp);return index;
}
const sleep=new Int32Array(new SharedArrayBuffer(4));
function withFileLock<T>(file:string,work:()=>T):T{
  const limit=Date.now()+15000;
  for(;;){
    let fd:number;
    try{fd=fs.openSync(file,"wx");}
    catch(error){
      if(error.code!=="EEXIST")throw error;
      const stat=fs.statSync(file,{throwIfNoEntry:false});
      if(stat && Date.now()-stat.mtimeMs>5000){
        // Only one contender can reclaim a dead owner's file at a time.
        let guard:number;
        try{guard=fs.openSync(file+".reap","wx");}catch(e){if(e.code!=="EEXIST")throw e;}
        if(guard!==undefined){
          try{
            const current=fs.statSync(file,{throwIfNoEntry:false});
            if(current && current.ino===stat.ino && current.mtimeMs===stat.mtimeMs){
              const pid=Number(fs.readFileSync(file,"utf8"));
              let alive=Number.isSafeInteger(pid) && pid>0;
              if(alive)try{process.kill(pid,0);}catch(e){alive=e.code!=="ESRCH";}
              if(!alive)fs.rmSync(file,{force:true});
            }
          }catch(e){if(e.code!=="ENOENT")throw e;}
          finally{fs.closeSync(guard);fs.rmSync(file+".reap",{force:true});}
        }
      }
      if(Date.now()>=limit)throw new Error("Timed out waiting for "+path.basename(file));
      Atomics.wait(sleep,0,0,15+Math.floor(Math.random()*36));continue;
    }
    try{fs.writeFileSync(fd,String(process.pid));return work();}
    finally{fs.closeSync(fd);fs.rmSync(file,{force:true});}
  }
}
// Host queries are serialized per root. Combine intermediate frontier updates
// into a single durable write before the host receives the result.
const pendingWrites=new Map<string,{index?:GraphIndex;files:Set<string>}>();
export function beginGraphWrites(root:string){pendingWrites.set(root,{files:new Set()});}
export function flushGraphWrites(root:string){
  const batch=pendingWrites.get(root);
  pendingWrites.delete(root);
  if(batch?.index && batch.files.size)persistIndex(root,batch.index,batch.files);
}
export function saveGraphIndex(projectRoot:string,index:GraphIndex,changed:Set<string>){
  const batch=pendingWrites.get(projectRoot);
  if(!batch){persistIndex(projectRoot,index,changed);return;}
  if(batch.index && batch.index!==index)persistIndex(projectRoot,batch.index,batch.files);
  if(batch.index!==index)batch.files.clear();
  batch.index=index;
  for(const file of changed)batch.files.add(file);
}
function persistIndex(projectRoot:string,index:GraphIndex,changed:Set<string>){
  const root=path.resolve(projectRoot),dir=ensureGraphDir(root),file=path.join(dir,INDEX_FILE);
  index.projectRoot=root;index.updatedAt=new Date().toISOString();
  // Retain the version observed before our write. A concurrent commit is then
  // detected on the next read, even when it landed just before this transaction.
  if(hasSql(root) && !fs.existsSync(file)){
    sqliteBackend().writeSqlIndex(root,index,changed,false);return;
  }
  // Publish the first JSON snapshot without allocating a second lock file.
  // A hard link installs complete bytes exclusively. Contending creators
  // merge their deltas under the regular lock when the destination exists.
  if(stamps.get(root)==="absent" && !jsonOnly(root) &&
      Object.keys(index.files).length<=SQL_FILE_THRESHOLD && !fs.existsSync(file)){
    const tmp=file+"."+randomUUID()+".tmp";
    try{
      fs.writeFileSync(tmp,JSON.stringify(index));
      const published=jsonStamp(tmp);
      fs.linkSync(tmp,file);
      if(!hasSql(root) && !fs.existsSync(path.join(dir,"index.lock"))){
        memoryIndexCache.set(root,index);stamps.set(root,published);return;
      }
    }catch(error){
      if(!["EEXIST","EPERM","ENOTSUP","EOPNOTSUPP","EXDEV","EACCES","ENOSYS"].includes(error.code))throw error;
    }finally{fs.rmSync(tmp,{force:true});}
  }
  withFileLock(path.join(dir,"index.lock"),()=>{
    if(hasSql(root)){
      sqliteBackend().writeSqlIndex(root,index,changed,true);fs.rmSync(file,{force:true});stamps.delete(root);return;
    }
    const before=jsonStamp(file);
    let next=index;
    if(before!=="absent" && before!==stamps.get(root)){
      const disk=JSON.parse(fs.readFileSync(file,"utf8")) as GraphIndex;
      next={...index,files:{...disk.files}};
      for(const f of changed){if(index.files[f])next.files[f]=index.files[f];else delete next.files[f];}
    }
    if(!jsonOnly(root) && Object.keys(next.files).length>SQL_FILE_THRESHOLD){
      sqliteBackend().writeSqlIndex(root,next,changed,true);
      fs.rmSync(file,{force:true});
      stamps.delete(root);
    }else{
      writeAtomic(file,next);memoryIndexCache.set(root,next);stamps.set(root,jsonStamp(file));
    }
  });
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
  const dir=path.join(path.resolve(root),GRAPH_DIR);
  const file=path.join(dir,GUIDE_FILE);
  function snapshot(){
    try{return fs.readFileSync(file,"utf8");}
    catch(e){if(e.code!=="ENOENT")throw e;return "";}
  }
  function changed(data:string){
    const guide:ArchGuideStore=data?JSON.parse(data):{version:1,patterns:[]};
    if(guide.version!==1)throw new Error("Unsupported guide version");
    guide.patterns??=[];
    const before=JSON.stringify(guide);
    edit(guide);
    return JSON.stringify(guide)===before?undefined:guide;
  }
  const original=snapshot();
  const proposal=changed(original);
  if(!proposal)return;
  ensureGraphDir(path.resolve(root));
  withFileLock(path.join(dir,"guide.lock"),()=>{
    const latest=snapshot();
    const next=latest===original?proposal:changed(latest);
    if(next)writeAtomic(file,next);
  });
}
