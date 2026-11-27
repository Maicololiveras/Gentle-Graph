import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
const script=fileURLToPath(import.meta.url);
const intent="subagent tool grants configuration global project discovery agent unknown warnings per-key API";
if(process.argv[2]==="--child"){
  const [engine,root]=process.argv.slice(3);
  const {sessionQuery,closeQuerySessions}=await import(pathToFileURL(path.join(engine,"lib/gentle-graph/query-session.ts")).href);
  try{
    const start=performance.now();
    const result=await sessionQuery({kind:"guide",term:intent,root});
    assert.match(result,/loadToolOverlays/);
    console.log(JSON.stringify({ms:performance.now()-start,chars:result.length}));
  }finally{await closeQuerySessions();}
}else{
  const host=path.resolve(process.argv[2]),repo=path.resolve(path.dirname(script),"..");
  const git=(cwd,...args)=>execFileSync("git",args,{cwd,stdio:"pipe",encoding:"utf8",windowsHide:true}).trim();
  const hook=new URL("./guide-trace-hook.mjs",import.meta.url).href;
  for(const ref of process.argv.slice(3)){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"cold-guide-")),engine=path.join(temp,"engine"),root=path.join(temp,"shell");
    try{
      git(repo,"worktree","add","--detach","-q",engine,ref);
      git(host,"worktree","add","--detach","-q",root,"c9b59eab57a56224c76b99e1caa9bb94cb113dc8");
      fs.symlinkSync(path.join(repo,"node_modules"),path.join(engine,"node_modules"),process.platform==="win32"?"junction":"dir");
      const child=spawnSync(process.execPath,["--import",hook,script,"--child",engine,root],{encoding:"utf8",windowsHide:true});
      if(child.status!==0)throw Error(child.stderr||child.error?.message);
      const spans=child.stderr.split(/\r?\n/).filter(l=>l.startsWith("GUIDE_SPAN ")).map(l=>JSON.parse(l.slice(11)));
      const timings={};
      for(const name of ["storeModule","nativeModule","databaseOpen","migration","guideLockAcquire","parse","saveIndex"]){
        const filtered=spans.filter(s=>s.name===name);
        timings[name]={count:filtered.length,ms:Number(filtered.reduce((sum,s)=>sum+s.end-s.start,0).toFixed(3))};
      }
      assert.ok(timings.parse.count>0 && timings.saveIndex.count>0,"Instrumentation must observe actual parsing and persistence");
      const dbCreated=fs.existsSync(path.join(root,".gentle-graph/index.sqlite"));
      console.log("COLD_GUIDE "+JSON.stringify({ref,sha:git(engine,"rev-parse","HEAD"),...JSON.parse(child.stdout.trim()),dbCreated,timings}));
      if(ref==="HEAD")for(const name of ["storeModule","nativeModule","databaseOpen","migration","guideLockAcquire"])assert.equal(timings[name].count,0,name);
      assert.equal(dbCreated,false);
    }finally{
      if(fs.existsSync(path.join(engine,"node_modules")))fs.unlinkSync(path.join(engine,"node_modules"));
      for(const [cwd,tree] of [[host,root],[repo,engine]])if(fs.existsSync(tree))git(cwd,"worktree","remove","--force",tree);
      fs.rmSync(temp,{recursive:true,force:true});
    }
  }
}
