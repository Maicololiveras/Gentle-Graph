import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
write(path.join(config,"tools.json"),{worker:{add:["custom"],remove:["old"]},bad:27});
write(path.join(cwd,".pi/gentle-ai/tools.json"),{worker:{add:["recovered"]},"*":{remove:["custom","recovered"],add:["old"]}});
const forAgent = name=>mod.loadToolOverlayForAgent(config,cwd,name);
test("exact after wildcard; project after global",()=>{
  const {entry,notices}=forAgent("worker");
  assert.deepEqual([...entry.add].sort(),["old","recovered"]);
  assert.deepEqual([...entry.remove].sort(),["custom","read"]);
  assert(notices.some(n=>n.includes("bad")));
});
test("wildcard applies to unrelated agents",()=>{
  const tools=mod.applyToolOverlay(["base"],forAgent("verify").entry);
  assert.deepEqual(tools.sort(),["base","old","read"]);
});
test("absent overlay and legacy loader",()=>{
  assert.equal(mod.loadToolOverlayForAgent(tmp,tmp,"missing").entry,undefined);
  assert(mod.loadToolOverlays(config,cwd).entries.worker);
});
test("normal discovery applies wildcard and retains unknown-agent notices",()=>{
  const agentHome=path.join(tmp,"home"), dir=path.join(agentHome,"agents");
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"worker.md"),"---\nname: worker\ntools:\n  - existing\n---\nbody");
  const result=agents.discoverAgents({cwd,home:agentHome,agentHome,configHome:config});
  const worker=result.agents.find(a=>a.name==="worker");
  assert(worker.tools.includes("old") && worker.tools.includes("recovered"));
  assert(!result.notices.some(n=>n.includes('unknown agent "*"')));
});
