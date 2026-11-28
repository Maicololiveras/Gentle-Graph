import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile,execFileSync} from "node:child_process";
import {promisify} from "node:util";
import {it} from "node:test";
import register from "../extensions/gentle-graph.ts";

const execute = promisify(execFile);
it("captures nested and direct routes in details and preserves graph content", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),"graph-route-"));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.writeFileSync(path.join(cwd,"billing.ts"),"export function billing() {}");
  const tools=new Map(), hooks=new Map();
  register({registerTool:t=>tools.set(t.name,t),on:(n,f)=>hooks.set(n,f)} as any);
  const ctx={cwd,sessionManager:{getSessionId:()=>"s1"}};
  try {
    for(const [id,parent] of [["first",undefined],["second","outer"]]){
      if(parent) hooks.get("tool_execution_start")({toolName:"codemode",toolCallId:parent});
      hooks.get("tool_execution_start")({toolName:"graph_inspect",toolCallId:id,parentToolCallId:parent});
      const r=await tools.get("graph_inspect").execute(id,{symbol:"billing"},null,null,ctx);
      const e=r.details.gentleGraph;
      assert.equal(e.sessionId,"s1"); assert.equal(e.viaCodemode,!!parent);
      assert.equal(e.worktreeRoot,cwd); assert.equal(e.charsOut,r.content[0].text.length);
      assert.equal(r.content.length,1); assert.doesNotMatch(r.content[0].text,/workMs|sessionId/);
      assert.equal(e.bootMs>0,!parent);
      hooks.get("tool_execution_end")({toolCallId:id});
    }
    assert.equal(fs.existsSync(path.join(cwd,".gentle-graph","telemetry.jsonl")),false);
  } finally {await hooks.get("session_shutdown")();}
});

it("rotates concurrent child logs and audits session, task and nested-call evidence once",async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"graph-audit-"));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const sessions=path.join(base,"sessions"), tasks=path.join(base,"tasks"), out=path.join(base,"out");
  fs.mkdirSync(sessions); fs.mkdirSync(tasks);
  const roots=["left","right"].map(name=>path.join(base,name));
  for(const root of roots){
    const dir=path.join(root,".gentle-graph"); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"telemetry.jsonl"),JSON.stringify({padding:"x".repeat(5*1024*1024)})+"\n");
  }
  const api=new URL("../lib/gentle-graph/telemetry.ts",import.meta.url);
  const script=`
    import {queryEvent,telemetryWriter} from ${JSON.stringify(api.href)};
    const [root,session] = process.argv.slice(2);
    const writer=telemetryWriter();
    for(let n=0;n<20;n++){
      const reply={text:"ok",partial:false,bootMs:n?0:10,workMs:2,engineMs:15,cacheHit:n>0,mode:"jit",indexed:1};
      writer.record(queryEvent("graph_guide",String(n),root,session,true,15,reply));
    }
    await writer.close();`;
  const roles=["worker","verify","explore","jd-fix-agent"];
  await Promise.all(roles.map(async(role,i)=>{
    const root=roots[i%2], id="child-"+i, sessionPath=path.join(sessions,id+".jsonl");
    fs.writeFileSync(sessionPath,[{type:"session",id,cwd:root},{toolsAdded:["graph_guide"]},
      {message:{role:"assistant",content:[{type:"toolCall",id:"r",name:"read"}]}},
      {message:{role:"toolResult",toolName:"codemode",nestedCalls:{calls:[{id:"0",name:"graph_guide"}]}}}
    ].map(r=>JSON.stringify(r)).join("\n"));
    fs.writeFileSync(path.join(tasks,id+".json"),JSON.stringify({task:{agent:role,cwd:root,sessionPath}}));
    const childFile=path.join(base,id+".mjs");
    fs.writeFileSync(childFile,script);
    await execute(process.execPath,[childFile,root,id],{windowsHide:true,
      env:{...process.env,GENTLE_GRAPH_TELEMETRY:"1",GENTLE_PI_AGENTS_CHILD:"1"}});
  }));
  for(const root of roots){
    const dir=path.join(root,".gentle-graph");
    assert.ok(fs.existsSync(path.join(dir,"telemetry.prev.jsonl")));
    const rows=fs.readFileSync(path.join(dir,"telemetry.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
    assert.equal(rows.length,40);
    assert.ok(rows.every(e=>e.isChild && e.worktreeRoot===root));
  }
  const stdout=execFileSync(process.execPath,["scripts/audit-gentle-graph.mjs",sessions,"--out",out],{encoding:"utf8",windowsHide:true});
  const report=JSON.parse(stdout);
  assert.deepEqual(report,JSON.parse(fs.readFileSync(path.join(out,"audit.json"),"utf8")));
  assert.equal(report.totalGraphCalls,80); assert.equal(report.total.codemode,80);
  assert.equal(report.total.read,4); assert.equal(report.total.hits,76);
  assert.equal(report.total.matchingRoot,80); assert.equal(report.malformed,0);
  assert.deepEqual(report.byRoleAndWorktree.map(g=>g.role).sort(),roles.sort());
  assert.match(fs.readFileSync(path.join(out,"audit.md"),"utf8"),/jd-fix-agent/);
});
