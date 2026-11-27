import assert from "node:assert/strict";
import {it} from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {fork} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {clearMemoryCache,loadGraphIndex,saveGraphIndex,updateArchGuide,loadArchGuide,jsonOnly,getLookup,patchLookup,invalidateLookup} from "../lib/gentle-graph/store.ts";
import {searchSqlFiles} from "../lib/gentle-graph/store-sqlite.ts";
import {syncGraphIndex} from "../lib/gentle-graph/indexer.ts";
import {execFileSync} from "node:child_process";
import {gitPaths} from "../lib/gentle-graph/git-scope.ts";
import type {FileNode} from "../lib/gentle-graph/types.ts";

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"graph-store-"));t.after(()=>{clearMemoryCache(root);fs.rmSync(root,{recursive:true,force:true});});return root;}
function node(file:string,name="apply"):FileNode{return {path:file,mtimeMs:1,sha256:"abcd",language:"typescript",imports:["./port"],exports:[name],
  symbols:[{id:file+"#"+name,name,file,kind:"method",line:5,endLine:7,exported:true,signature:"apply()",calls:["load"],
    contracts:["Port"],localCallees:[],importCallees:["load"],qualifiedCalls:["Store.load"],domainTag:"billing",reuseTag:"canonical",
    sites:[{target:"RunCommand",line:6,role:"Binding",text:"Run",qualified:"Model.Run"}]}]};}
function database(root:string){return new DatabaseSync(path.join(root,".gentle-graph","index.sqlite"));}
it("commits eight simultaneous subprocess deltas and refreshes an existing reader",async t=>{
  const root=fixture(t),prior=process.env.GENTLE_GRAPH_STORE;
  process.env.GENTLE_GRAPH_STORE="sqlite";
  try{
    fs.mkdirSync(path.join(root,".gentle-graph"));database(root).close();
    const index=loadGraphIndex(root);index.files["seed.ts"]=node("seed.ts");saveGraphIndex(root,index,new Set(["seed.ts"]));
    const reader=loadGraphIndex(root);assert.equal(Object.keys(reader.files).length,1);
    const children=Array.from({length:8},(_,i)=>fork(fileURLToPath(new URL("./sqlite-writer.mjs",import.meta.url)),[root,String(i)],{silent:true}));
    const completed=children.map(child=>new Promise<void>((resolve,reject)=>{
      let err="";child.stderr.on("data",chunk=>err+=chunk);child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(Error(err||String(code))));
    }));
    // Schedule all exit handlers before waiting for the barrier.
    const done=Promise.all(completed);done.catch(()=>{});
    try{
      await Promise.race([Promise.all(children.map(child=>new Promise(r=>child.once("message",r)))),done]);
      for(const child of children)child.send("go");
      await done;
    }finally{for(const child of children)child.kill();}
    assert.equal(Object.keys(loadGraphIndex(root).files).length,9);
    assert.equal(loadArchGuide(root).patterns.length,8);
  }finally{if(prior===undefined)delete process.env.GENTLE_GRAPH_STORE;else process.env.GENTLE_GRAPH_STORE=prior;}
});
it("migrates legacy blobs, preserves relationships, and cascades file replacement and deletion",t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,".gentle-graph"));
  let db=database(root);
  const file=node("item.ts");
  db.exec("CREATE TABLE files(path TEXT PRIMARY KEY,data TEXT); CREATE TABLE metadata(version INTEGER,updatedAt TEXT); INSERT INTO metadata VALUES(8,'old')");
  db.prepare("INSERT INTO files VALUES(?,?)").run(file.path,JSON.stringify(file));db.close();
  const index=loadGraphIndex(root);assert.deepEqual(index.files[file.path],file);
  db=database(root);
  try{
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,2);
    index.files[file.path]=node(file.path,"replacement");saveGraphIndex(root,index,new Set([file.path]));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM symbols WHERE name='apply'").get().n,0);
    assert.deepEqual(searchSqlFiles(root,"replacement"),[file.path]);
    delete index.files[file.path];saveGraphIndex(root,index,new Set([file.path]));
    for(const table of ["symbols","edges","symbol_values","file_values","files_fts"])assert.equal(db.prepare("SELECT COUNT(*) n FROM "+table).get().n,0);
  }finally{db.close();}
});
it("leaves a newer database and its sentinel untouched",t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,".gentle-graph"));const db=database(root);
  db.exec("PRAGMA user_version=17; CREATE TABLE sentinel(value);INSERT INTO sentinel VALUES('safe')");db.close();
  const bytes=fs.readFileSync(path.join(root,".gentle-graph/index.sqlite"));
  assert.throws(()=>loadGraphIndex(root),/future/);
  assert.deepEqual(fs.readFileSync(path.join(root,".gentle-graph/index.sqlite")),bytes);
  assert.equal(fs.existsSync(path.join(root,".gentle-graph/index.json")),false);
});
it("ranks normalized FTS rows directly over 2200 files in under 10 ms",t=>{
  const root=fixture(t),index=loadGraphIndex(root);
  for(let i=0;i<2200;i++){const file=i+".ts";index.files[file]=node(file,i===2000?"NeedleFunction":"ordinary");}
  saveGraphIndex(root,index,new Set(Object.keys(index.files)));
  const start=performance.now();const hits=searchSqlFiles(root,"NeedleFunction");const ms=performance.now()-start;
  assert.deepEqual(hits,["2000.ts"]);t.diagnostic("FTS5: "+ms.toFixed(3)+" ms");assert.ok(ms<10,String(ms));
});
it("patches unchanged importers, overload buckets and reverse references like a fresh lookup",t=>{
  const root=fixture(t),index=loadGraphIndex(root);
  for(const f of ["a.ts","b.ts","port/index.ts"])index.files[f]=node(f);
  const old=getLookup(index);
  delete index.files["b.ts"];index.files["port.ts"]=node("port.ts","newSymbol");index.files["a.ts"]=node("a.ts","updated");
  patchLookup(index,["a.ts","port.ts"],["b.ts"]);
  assert.equal(getLookup(index),old);
  invalidateLookup(index);assert.deepEqual(old,getLookup(index));
});
it("recognizes UNC paths and distinguishes missing Git worktrees from command failures",async t=>{
  const root=fixture(t);assert.ok(jsonOnly(String.raw`\\server\share\repo`));assert.ok(jsonOnly("//server/share/repo"));
  assert.equal((await gitPaths(root,["status"])).status,"not_git");
  assert.equal((await gitPaths(root,["invalid-gentle-graph-command"])).status,"git_error");
});

it("serves cached paths after an inventory error without indexing unlisted files",t=>{
  const root=fixture(t);
  fs.writeFileSync(path.join(root,"known.ts"),"export function known() {}");
  execFileSync("git",["init","-q"],{cwd:root,windowsHide:true});
  execFileSync("git",["add","known.ts"],{cwd:root,windowsHide:true});
  assert.ok(syncGraphIndex(root).index.files["known.ts"]);
  fs.writeFileSync(path.join(root,".git","index"),"broken");
  fs.writeFileSync(path.join(root,"never-scan.ts"),"export function surprise() {}");
  const scope=syncGraphIndex(root,true);
  assert.equal(scope.degraded,true);assert.deepEqual(scope.knownFiles,["known.ts"]);assert.equal(scope.stats.scanned,0);
});
it("refreshes JSON after an external replacement and reclaims an abandoned guide lock",t=>{
  const root=fixture(t),index=loadGraphIndex(root);
  index.files["x.ts"]=node("x.ts");saveGraphIndex(root,index,new Set(["x.ts"]));
  const dir=path.join(root,".gentle-graph"),file=path.join(dir,"index.json");
  const copy=JSON.parse(fs.readFileSync(file,"utf8"));copy.files["y.ts"]=node("y.ts");
  fs.writeFileSync(file+".replacement",JSON.stringify(copy));fs.renameSync(file+".replacement",file);
  assert.ok(loadGraphIndex(root).files["y.ts"]);
  const lock=path.join(dir,"guide.lock");
  fs.writeFileSync(lock,String(process.pid));
  updateArchGuide(root,()=>{});
  assert.equal(fs.existsSync(path.join(dir,"guide.json")),false);
  fs.writeFileSync(lock,"");fs.utimesSync(lock,1,1);
  updateArchGuide(root,g=>{g.rules=["changed"];});
  assert.deepEqual(loadArchGuide(root).rules,["changed"]);assert.ok(!fs.existsSync(lock));
});
