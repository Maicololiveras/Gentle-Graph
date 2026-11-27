import {parentPort} from "node:worker_threads";
import {gitSnapshot,gitSessionInventory,adoptGitSnapshot,GitScopeError,type GitSnapshot} from "./git-scope.ts";
import {syncGraphIndex} from "./indexer.ts";
import {guideFromScope} from "./query-guide.ts";
import {inspectSteps} from "./query-inspect.ts";
import {impactSteps} from "./query-impact.ts";
import {runAsync} from "./query-shared.ts";
import {formatGuide,formatInspect,formatImpact} from "./format.ts";
import type {Query} from "./query-session.ts";

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
    const result=await runAsync(q.root,impactSteps(q.term,{},q.root,scope,deadline,partial=>
      parentPort.postMessage({checkpoint:formatImpact(partial)})),state,deadline);
    text=formatImpact(result);
    if(result.partial)return text;
  }
  if(state){
    if(state.results.size>=64)state.results.delete(state.results.keys().next().value);
    state.results.set(key,text);
  }
  return text;
}
parentPort.on("message",async({query,prepared}:{query:Query;prepared?:Prepared})=>{
  try { parentPort.postMessage({text:await handle(query,prepared)}); }
  catch(e){if(query.kind==="impact" && e instanceof GitScopeError && e.timedOut) parentPort.postMessage({timedOut:true});
    else parentPort.postMessage({error:String(e)});}
});
