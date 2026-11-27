import {parentPort} from "node:worker_threads";
import {gitSnapshot,gitSessionInventory} from "./git-scope.ts";
import {syncGraphIndex} from "./indexer.ts";
import {guideFromScope} from "./query-guide.ts";
import {inspectSteps} from "./query-inspect.ts";
import {impactSteps} from "./query-impact.ts";
import {runAsync} from "./query-shared.ts";
import {formatGuide,formatInspect,formatImpact} from "./format.ts";
import type {Query} from "./query-session.ts";

async function handle(q:Query){
  const deadline=performance.now()+1450;
  const state=await gitSnapshot(q.root);
  const key=JSON.stringify(q);
  const cached=state?.results.get(key);
  if(cached!==undefined)return cached;
  const inventory=await gitSessionInventory(q.root,state);
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
parentPort.on("message",async(q:Query)=>{
  try { parentPort.postMessage({text:await handle(q)}); }
  catch(e){parentPort.postMessage({error:String(e)});}
});
