// Replay only graph read operations and recheck saved patches. Never replay bash/edit tool calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {graphGuide,graphInspect,graphImpact} from "../lib/gentle-graph/index.ts";
import {clearMemoryCache,loadGraphIndex} from "../lib/gentle-graph/store.ts";
import {formatGuide,formatInspect,formatImpact} from "../lib/gentle-graph/format.ts";
const [repoArg,pairArg]=process.argv.slice(2);
if(!pairArg) throw new Error("Usage: node scripts/replay-shell-pair.mjs SHELL_REPO PAIR_DIR");
const repo=fs.realpathSync(repoArg), pair=fs.realpathSync(pairArg);
const {sha}=JSON.parse(fs.readFileSync(path.join(pair,"results.json"),"utf8"));
if(!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid commit SHA");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"gentle-graph-replay-"));
const git=(cwd,...args)=>execFileSync("git",args,{cwd,stdio:"pipe"});
const sessions=path.join(pair,"graph","sessions");
const commands=[];
for(const file of fs.readdirSync(sessions,{recursive:true}).filter(f=>f.endsWith(".jsonl"))){
  for(const line of fs.readFileSync(path.join(sessions,file),"utf8").split(/\r?\n/).filter(Boolean)){
    const msg=JSON.parse(line).message;
    if(msg?.role==="assistant" && Array.isArray(msg.content)) for(const c of msg.content){
      if(c.type==="toolCall" && ["graph_guide","graph_inspect","graph_impact"].includes(c.name)) commands.push(c);
    }
  }
}
if(!commands.length) throw new Error("No graph read calls in transcript");
const report={sha,measurements:[],quality:{}};
const work=path.join(out,"tree");
const quality=fileURLToPath(new URL("./bench-shell/quality.mjs",import.meta.url));
function run(call,mode){
  const p=call.arguments, opts={...p,projectRoot:work};
  const start=performance.now();
  const value=call.name==="graph_guide"?formatGuide(graphGuide(p.intent,opts)):
    call.name==="graph_inspect"?formatInspect(graphInspect(p.symbol,opts)):formatImpact(graphImpact(p.target,opts));
  report.measurements.push({mode,tool:call.name,id:call.id,query:p.intent??p.symbol??p.target,ms:performance.now()-start,
    indexed:Object.keys(loadGraphIndex(work).files).length,responseChars:value.length});
}
function cold(){
  clearMemoryCache(work);
  fs.rmSync(path.join(work,".gentle-graph"),{recursive:true,force:true});
}
for(const arm of ["graph","baseline"]){
  git(repo,"worktree","add","--detach",work,sha);
  try{
    if(arm==="graph"){
      // Preserve committed patterns while resetting only generated cache files.
      const guide=path.join(work,".gentle-graph","guide.json");
      const original=fs.existsSync(guide)?fs.readFileSync(guide):null;
      function reset(){cold();if(original){fs.mkdirSync(path.dirname(guide),{recursive:true});fs.writeFileSync(guide,original);}}
      for(const c of commands){reset();run(c,"isolated");}
      reset();
      for(const c of commands)run(c,"sequence");
    }
    const patch=path.join(pair,arm,"changes.patch");
    if (fs.statSync(patch).size) git(work,"apply","--whitespace=nowarn",patch);
    const check=spawnSync(process.execPath,[quality],{cwd:work,env:{...process.env,GENTLE_BENCH_MODULES:path.join(repo,"node_modules")},encoding:"utf8"});
    report.quality[arm]=check.status;
    fs.writeFileSync(path.join(out,arm+"-quality.txt"),[check.stdout,check.stderr,check.error].filter(Boolean).join("\n"));
  } finally {git(repo,"worktree","remove","--force",work);}
}
fs.writeFileSync(path.join(out,"replay.json"),JSON.stringify(report,null,2));
console.table(report.measurements);
console.log("Quality exit codes:",report.quality,"Report:",out);
if(Object.values(report.quality).some(code=>code!==0)) process.exitCode=1;
