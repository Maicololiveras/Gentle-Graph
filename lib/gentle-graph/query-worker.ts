import {existsSync} from "node:fs";
import path from "node:path";
import {typescript,workspaceCompiler} from "./languages/typescript.ts";
import {parentPort,receiveMessageOnPort,workerData,type MessagePort} from "node:worker_threads";
import {gitSnapshot,gitSessionInventory,adoptGitSnapshot,GitScopeError,type GitSnapshot} from "./git-scope.ts";
import {syncGraphIndex} from "./indexer.ts";
import {guideFromScope} from "./query-guide.ts";
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

type Prepared = [GitSnapshot | null, Awaited<ReturnType<typeof gitSessionInventory>>];
async function handle(q:Query,prepared?:Prepared){
  const deadline=performance.now()+1450;
  const state=prepared ? prepared[0] : await gitSnapshot(q.root);
  if(prepared && state){state.inventory=prepared[1]??undefined;adoptGitSnapshot(state); }
  const key=JSON.stringify(q);
  const cached=state?.results.get(key);
  if(cached!==undefined)return cached;
  const inventory=prepared ? prepared[1] : await gitSessionInventory(q.root,state);
  const scope=syncGraphIndex(q.root,{inventory,dirty:state?.dirty,refresh:true});
  let text:string;
  if(q.kind==="guide"){
    text=formatGuide(guideFromScope(q.term,q,q.root,scope));
  } else if(q.kind==="inspect"){
    text=formatInspect(await runAsync(q.root,inspectSteps(q.term,q,q.root,scope),state));
  } else {
    const prefetch = scope.mode === "jit" && existsSync(path.join(q.root,"tsconfig.json"));
    const result=await runAsync(q.root,impactSteps(q.term,{},q.root,scope,deadline,partial=>
      parentPort.postMessage({checkpoint:formatImpact(partial)})),state,deadline,prefetch);
    text=formatImpact(result);
    if(result.partial)return text;
  }
  if(state){
    if(state.results.size>=64)state.results.delete(state.results.keys().next().value);
    state.results.set(key,text);
  }
  return text;
}
parentPort.on("message",async({query,prepared,inventoryReady}:{query:Query;prepared?:Prepared;inventoryReady?:number})=>{
  try {
    const received = profile ? performance.now() : 0;
    const text = await handle(query,prepared);
    if(profile && prepared && inventoryReady !== undefined) {
      const start = initial.profileStart!;
      console.error(JSON.stringify({graphProfile:"inspectCold",start,inventoryReady,workerReady,compilerEnd,received,end:performance.now()}));
    }
    parentPort.postMessage({text});
  }
  catch(e){if(query.kind==="impact" && e instanceof GitScopeError && e.timedOut) parentPort.postMessage({timedOut:true});
    else parentPort.postMessage({error:String(e)});}
});
