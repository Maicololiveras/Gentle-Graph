import {existsSync} from "node:fs";
import path from "node:path";
import {typescript,workspaceCompiler} from "./languages/typescript.ts";
import {parentPort,receiveMessageOnPort,workerData,type MessagePort} from "node:worker_threads";
import {gitSnapshot,gitSessionInventory,adoptGitSnapshot,coldTrackedPaths,GitScopeError,type GitSnapshot} from "./git-scope.ts";
import {indexStamp,beginGraphWrites,flushGraphWrites} from "./store.ts";
import {syncGraphIndex,cachedScope} from "./indexer.ts";
import {guideFromScope,previewTrackedGuide} from "./query-guide.ts";
import {inspectSteps} from "./query-inspect.ts";
import {impactSteps} from "./query-impact.ts";
import {runAsync} from "./query-shared.ts";
import {formatGuide,formatInspect,formatImpact} from "./format.ts";
import type {Query} from "./query-session.ts";

// Git discovers the first worktree scope concurrently on the parent thread.
const initial = workerData as Query & {profileStart?:number;compiler?:{port:MessagePort;signal:Int32Array}};
const profile = initial.kind === "inspect" && initial.profileStart !== undefined;
const workerReady = profile ? performance.now() : 0;
let compilerEnd = workerReady;
if (initial.compiler) {
  const {port,signal}=initial.compiler;
  const localParse=typescript.parse;
  typescript.parse=(root,file,content)=>{
    const version=Atomics.load(signal,0);
    if (!Atomics.load(signal,1)) {
      port.postMessage({file,content});
      // Only the isolated graph worker waits. On a crash or timeout, resume
      // with the same local adapter and retire the port to avoid stale replies.
      const waited=Atomics.wait(signal,0,version,4000);
      const reply=waited==="timed-out" ? undefined : receiveMessageOnPort(port)?.message;
      if (reply?.parsed) return reply.parsed;
    }
    typescript.parse=localParse;
    port.close();
    return localParse(root,file,content);
  };
} else if (initial.kind !== "guide" && existsSync(path.join(initial.root, "tsconfig.json"))) {
  workspaceCompiler(initial.root);
  if (profile) compilerEnd = performance.now();
}

const profileCache={};
let previews:ReturnType<typeof previewTrackedGuide>;
if(initial.kind==="guide" && process.platform==="win32"){
  const tracked=coldTrackedPaths(initial.root);
  if(tracked)previews=previewTrackedGuide(initial.root,initial.term,tracked);
}
type Prepared = [GitSnapshot | null, Awaited<ReturnType<typeof gitSessionInventory>>];
let publishing:Promise<void>|undefined;
async function handle(q:Query,prepared?:Prepared,degraded=false){
  const deadline=performance.now()+1450;
  let state=degraded?null:prepared ? prepared[0] : await gitSnapshot(q.root,JSON.stringify([q.kind,q.term])).catch(e=>{if(!(e instanceof GitScopeError))throw e;degraded=true;return null;});
  if(prepared && state){state.inventory=prepared[1]??undefined;adoptGitSnapshot(state); }
  const key=JSON.stringify(q);
  const cacheKey=key+indexStamp(q.root);
  const cached=state?.results.get(cacheKey);
  if(cached!==undefined)return cached;
  if(publishing){
    await publishing;
    const committed=state?.results.get(key+indexStamp(q.root));
    if(committed!==undefined)return committed;
  }
  const inventory=degraded?null:prepared ? prepared[1] : await gitSessionInventory(q.root,state);
  let publication:ReturnType<typeof flushGraphWrites>;
  let text:string,partial=false,mode:string,indexed:number;
  const timings=prepared && initial.profileStart!==undefined ? {scope:0,query:0,flush:0} : undefined;
  const started=performance.now();
  beginGraphWrites(q.root);
  try {
  const scope=degraded?cachedScope(q.root):syncGraphIndex(q.root,{inventory,dirty:state?.dirty,refresh:true});
  if(timings)timings.scope=performance.now()-started;
  mode=scope.degraded?"degraded":scope.mode;
  if(q.kind==="guide"){
    text=formatGuide(guideFromScope(q.term,q,q.root,scope,profileCache,previews));
    previews=undefined;
  } else if(q.kind==="inspect"){
    text=formatInspect(await runAsync(q.root,inspectSteps(q.term,q,q.root,scope),state));
  } else {
    const prefetch = scope.mode === "jit" && existsSync(path.join(q.root,"tsconfig.json"));
    const result=await runAsync(q.root,impactSteps(q.term,{},q.root,scope,deadline,partial=>
      parentPort.postMessage({checkpoint:formatImpact(partial)})),state,deadline,prefetch);
    text=formatImpact(result);
    partial=!!result.partial;
  }
  indexed=Object.keys(scope.index.files).length;
  } finally {
    if(timings)timings.query=performance.now()-started-timings.scope;
    try{publication=flushGraphWrites(q.root,!!prepared && !!state && mode==="jit",stamp=>{
      if(state && !partial && !degraded)state.results.set(key+stamp,{text,partial,mode,indexed});
    });}catch(e){if(!["EROFS","EACCES","EPERM"].includes(e.code))throw e;}
  }
  if(timings){
    timings.flush=performance.now()-started-timings.scope-timings.query;
    console.error(JSON.stringify({graphProfile:"worker",kind:q.kind,...timings}));
  }
  const reply={text,partial,mode,indexed};
  if(state && !partial && !degraded){
    if(state.results.size>=64)state.results.delete(state.results.keys().next().value);
    state.results.set(key+indexStamp(q.root),reply);
  }
  if(publication){
    publishing=publication.catch(error=>{
      // An unavailable disk cache does not invalidate the computed answer.
      if(initial.profileStart!==undefined)console.error("Graph cache publication failed",error.code);
    }).finally(()=>{publishing=undefined;});
  }
  return reply;
}
parentPort.on("message",async({query,prepared,inventoryReady,degraded,close}:{close?:boolean;query:Query;prepared?:Prepared;inventoryReady?:number;degraded?:boolean})=>{
  if(close){await publishing;parentPort.postMessage({drained:true});return;}
  try {
    const received = profile ? performance.now() : 0;
    let result:Awaited<ReturnType<typeof handle>>;
    try{result=await handle(query,prepared,degraded);}
    catch(error){
      if(!(error instanceof GitScopeError) || degraded)throw error;
      result=await handle(query,undefined,true);
    }
    if(profile && prepared && inventoryReady !== undefined) {
      const start = initial.profileStart!;
      console.error(JSON.stringify({graphProfile:"inspectCold",start,inventoryReady,workerReady,compilerEnd,received,end:performance.now()}));
    }
    parentPort.postMessage({result});
  }
  catch(e){if(query.kind==="impact" && e instanceof GitScopeError && e.timedOut) parentPort.postMessage({timedOut:true});
    else parentPort.postMessage({error:String(e)});}
});
