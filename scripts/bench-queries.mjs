import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {sessionQuery,closeQuerySessions} from "../lib/gentle-graph/query-session.ts";

const repository=path.resolve(process.argv[2] ?? ".");
const commit="c9b59eab57a56224c76b99e1caa9bb94cb113dc8";
const intent="subagent tool grants configuration global project discovery agent unknown warnings per-key API";
const failures=[];
for(const [kind,limit] of [["guide",350],["inspect",800],["impact",1000]]) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"gentle-query-"));
  const root=path.join(temp,"checkout");
  const git=(...args)=>execFileSync("git",args,{cwd:repository,windowsHide:true,stdio:"pipe"});
  let added=false;
  try {
    git("worktree","add","--detach","--quiet",root,commit);
    added=true;
    const query={kind,root,term:kind==="guide"?intent:"loadToolOverlays"};
    let cold;
    for(const [phase,budget] of [["cold",limit],["repeat",50]]){
      const start=performance.now();
      const result=await sessionQuery(query);
      const ms=performance.now()-start;
      console.log(JSON.stringify({kind,phase,ms,budget,chars:result.length,partial:result.startsWith("Partial")}));
      if(ms>=budget || result.startsWith("Partial")) failures.push(kind+" "+phase);
      if(!cold)cold=result;else if(cold!==result)failures.push(kind+" inconsistent output");
      if(kind==="guide"){
        assert.ok(result.length<1200);
        assert.doesNotMatch(result,/fixtures\/|\.fixture\.json|\.snap\b/);
        for(const file of ["lib/agents-config.ts","lib/agent-tool-overlay.ts"])
          assert.ok(result.split("\n").slice(0,3).some(line=>line.startsWith(file+" ") && / L\d+-\d+ .*test tests\//.test(line)),result);
        assert.match(result,/lib\/agents-config\.ts discoverAgentsIn L285-309 .*tests\/agents-config\.test\.ts/);
        assert.match(result,/lib\/agent-tool-overlay\.ts loadToolOverlays L64-111 <- lib\/agents-config\.ts:286 test tests\/agent-tool-overlay\.test\.ts/);
      } else if(!result.startsWith("Partial")) {
        assert.match(result,/lib\/agents-config\.ts:\d+#discoverAgentsIn/);
      }
    }
  } finally {
    await closeQuerySessions();
    if(added)git("worktree","remove","--force",root);
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
}
assert.deepEqual(failures,[],"Performance or completeness gate");
