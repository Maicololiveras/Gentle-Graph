import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {reportABC} from "../scripts/bench-shell/abc-report.mjs";

test("ABC compares only complete valid rounds and preserves missing edit timings",t=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),"gg-abc-report-"));
  t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
  const orders=["ABC","BCA","CAB"];
  const rows=orders.flatMap((order,i)=>[...order].map(arm=>({
    round:i+1,arm,folder:out,valid:i!==1 || arm!=="B",tokens:{A:120,B:150,C:90}[arm],
    costUSD:1,elapsedMs:10,firstEditMs:arm==="B" && i===2?null:2,
    tools:arm==="C"?{codemode:1,graph_inspect:1}:{read:1},nested:arm==="C"?{graph_inspect:1}:{}
  })));
  const manifest={out,orders,rows};
  reportABC(manifest);
  assert.deepEqual(manifest.validRounds,[1,3]);
  assert.equal(manifest.consolidated.tokens.CvsA,25);
  assert.equal(manifest.consolidated.tokens.CvsB,40);
  assert.equal(manifest.consolidated.firstEditMs.B.sum,null);
  assert.equal(manifest.consolidated.firstEditMs.CvsB,null);
  assert.match(fs.readFileSync(path.join(out,"informe-abc.md"),"utf8"),/1 \(1 anidadas\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,"summary.json"))).rows.length,9);
});

test("ABC resolves the bundled executable and unbundled runtime from one pinned package",async t=>{
  const {resolvePiRuntime}=await import("../scripts/bench-shell/abc.mjs");
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gg-abc-pi-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const metadata={name:"@earendil-works/pi-coding-agent",version:"1.6.0",main:"./dist/index.js",bin:{pi:"dist/bundle/cli.js"}};
  const manifest=path.join(root,"package.json");
  fs.writeFileSync(manifest,JSON.stringify(metadata));
  for(const name of [metadata.bin.pi,"dist/cli.js","dist/cli/setup.js","dist/main.js","dist/core/auth-storage.js","dist/core/model-runtime.js"]){
    const file=path.join(root,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,name===metadata.bin.pi?'console.log("1.6.0")':"");
  }
  assert.deepEqual(resolvePiRuntime(root),{pkg:root,bin:path.join(root,metadata.bin.pi),cli:path.join(root,"dist/cli.js"),pi:"1.6.0"});
  fs.writeFileSync(manifest,JSON.stringify({...metadata,version:"0.85.1"}));
  assert.throws(()=>resolvePiRuntime(root),/1\.6\.0/);
});

test("ABC loads the Codex import-only provider from the selected Pi installation",async t=>{
  const {loadCodexOAuth}=await import("../scripts/bench-shell/abc-auth.mjs");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gg-abc-oauth-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pkg=path.join(root,"node_modules","@earendil-works","pi-ai");
  fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(path.join(pkg,"package.json"),JSON.stringify({
    name:"@earendil-works/pi-ai",version:"1.6.0",type:"module",
    exports:{"./providers/*":{import:"./*.js"}},
  }));
  fs.writeFileSync(path.join(pkg,"openai-codex.js"),'export const openaiCodexProvider=()=>({auth:{oauth:{name:"fixture"}}})');
  assert.equal((await loadCodexOAuth(path.join(root,"cli.js"))).name,"fixture");
});

test("captures tracked and new files around ignored modules without changing the real index",async t=>{
  const {execFileSync}=await import("node:child_process");
  const {capturePatch}=await import("../scripts/bench-shell/abc-worktree.mjs");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"abc-patch-test-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync("git",args,{cwd:root,stdio:["ignore","pipe","pipe"]});
  git("init","-q");
  fs.writeFileSync(path.join(root,".gitignore"),"node_modules/\n*.ignored\n");
  fs.writeFileSync(path.join(root,"old"),"old\n");
  git("add",".");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","fixture");
  for(const name of ["node_modules",".codegraph",".gentle-graph"]){
    fs.mkdirSync(path.join(root,name));
    fs.writeFileSync(path.join(root,name,"noise"),"ignored engine output");
  }
  assert.equal(capturePatch(root).length,0);
  fs.unlinkSync(path.join(root,"old"));
  fs.writeFileSync(path.join(root,"new [feature]"),Buffer.from([0,1,2,3]));
  fs.writeFileSync(path.join(root,"other.ignored"),"excluded");
  const status=git("status","--porcelain=v1","-z");
  const patch=capturePatch(root).toString();
  assert.match(patch,/deleted file mode/);
  assert.match(patch,/new \[feature\]/);
  assert.match(patch,/GIT binary patch/);
  assert.doesNotMatch(patch,/node_modules|\.codegraph|\.gentle-graph|other\.ignored/);
  assert.deepEqual(git("status","--porcelain=v1","-z"),status);
});

test("cleanup retries locked worktrees and continues after a persistent error",async t=>{
  const {cleanWorktrees}=await import("../scripts/bench-shell/abc-worktree.mjs");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"abc-retry-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const [good,busy,preserve]=["good","busy","preserve"].map(name=>path.join(dir,name));
  const calls=[];
  const errors=await cleanWorktrees([["repo",good],["repo",busy],["repo",preserve]],(_root,cwd)=>{
    calls.push(cwd);
    if(cwd===busy)throw Error("locked");
  },new Set([preserve]),()=>true);
  assert.deepEqual(calls,[busy,busy,busy,busy,good]);
  assert.deepEqual(errors,[{cwd:busy,error:"Error: locked"}]);
});

test("cleanup removes an unregistered CodeGraph directory and preserves sibling worktrees",async t=>{
  const {execFileSync}=await import("node:child_process");
  const {cleanWorktrees}=await import("../scripts/bench-shell/abc-worktree.mjs");
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"abc-orphan-")));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,"repo"), arm=path.join(temp,"r3-gs-codegraph"), sibling=path.join(temp,"historical");
  fs.mkdirSync(root);
  const git=(...args)=>execFileSync("git",args,{cwd:root,windowsHide:true,stdio:"pipe"});
  git("init","-q");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-qm","fixture");
  for(const dir of [arm,sibling])git("worktree","add","--detach",dir,"HEAD");
  let attempts=0;
  const errors=await cleanWorktrees([[root,arm]],()=>{
    attempts++;
    git("worktree","remove","--force",arm);
    fs.mkdirSync(path.join(arm,".codegraph"),{recursive:true});
    fs.writeFileSync(path.join(arm,".codegraph","index"),"residue");
    throw Error("Invalid argument");
  });
  assert.deepEqual(errors,[]);
  assert.equal(attempts,1);
  assert.equal(fs.existsSync(arm),false);
  assert.ok(fs.existsSync(path.join(sibling,".git")));
  assert.ok(git("worktree","list","--porcelain").toString().includes("historical"));
});
