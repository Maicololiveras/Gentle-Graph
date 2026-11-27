import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
const mod = await import(pathToFileURL(path.resolve("lib/agent-tool-overlay.ts")));
const agents = await import(pathToFileURL(path.resolve("lib/agents-config.ts")));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"shell-accept-"));
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const config = path.join(tmp,"config"), cwd = path.join(tmp,"project");
function write(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value));
}
write(path.join(config,"agent-overlays.d","01.json"),{"*":{add:["read","old"]},worker:{remove:["read"]}});
write(path.join(config,"tools.json"),{worker:{add:["custom"],remove:["old"]},ghost:{add:["idle"]},bad:27});
write(path.join(cwd,".pi/gentle-ai/tools.json"),{worker:{add:["recovered"]},"*":{remove:["custom","recovered"],add:["old"]}});
const agentHome=path.join(tmp,"home"), dir=path.join(agentHome,"agents");
fs.mkdirSync(dir,{recursive:true});
for(const name of ["worker","verify"]) fs.writeFileSync(path.join(dir,name+".md"),"---\nname: "+name+"\ntools:\n  - existing\n---\nbody");
const roots={cwd,home:agentHome,agentHome,configHome:config};
const files=[path.join(config,"agent-overlays.d","01.json"),path.join(config,"tools.json"),path.join(cwd,".pi/gentle-ai/tools.json")];
const reads=new Map(files.map(file=>[file,0]));
const readFileSync=fs.readFileSync;
let result;
try {
  fs.readFileSync=function(file,...args) {
    if(reads.has(file)) reads.set(file,reads.get(file)+1);
    return readFileSync.call(this,file,...args);
  };
  syncBuiltinESMExports();
  result=agents.discoverAgents(roots);
} finally {fs.readFileSync=readFileSync;syncBuiltinESMExports();}
test("each config file is read once for both agents",()=>{
  assert.deepEqual([...reads.values()],[1,1,1]);
});
const tools=name=>result.agents.find(a=>a.name===name).tools;
test("per-file and inter-file precedence through discovery",()=>{
  assert(tools("worker").includes("recovered") && tools("worker").includes("old"));
  assert(!tools("worker").includes("custom") && !tools("worker").includes("read"));
});
test("wildcard applies to the second agent",()=>{
  for (const tool of ["existing","old","read"]) assert(tools("verify").includes(tool));
  assert(!tools("verify").includes("recovered"));
});
test("legacy loader preserves literal entries",()=>{
  const {entries}=mod.loadToolOverlays(config,cwd);
  assert.deepEqual([...entries.worker.add].sort(),["custom","recovered"]);
  assert.deepEqual([...entries.worker.remove].sort(),["old","read"]);
  assert.deepEqual([...entries["*"].add].sort(),["old","read"]);
  assert.deepEqual([...entries["*"].remove].sort(),["custom","recovered"]);
});
test("invalid entries still warn and wildcard is recognized",()=>{
  assert(result.notices.some(n=>n.includes("bad")));
  assert(result.notices.some(n=>n.includes('unknown agent "ghost"')));
  assert(!result.notices.some(n=>n.includes('unknown agent "*"')));
});
