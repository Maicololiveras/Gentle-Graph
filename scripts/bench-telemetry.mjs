import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {queryEvent,telemetryWriter} from "../lib/gentle-graph/telemetry.ts";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"gentle-log-bench-"));
const writer=telemetryWriter();
const samples=[];
const reply={text:"ok",mode:"jit",indexed:1,partial:false,cacheHit:true,bootMs:0,workMs:2,engineMs:3};
process.env.GENTLE_GRAPH_TELEMETRY="1";
try {
  for(let i=0;i<1000;i++){
    const start=performance.now();
    writer.record(queryEvent("graph_inspect",String(i),root,"bench",false,3,reply));
    // Include microtasks queued ahead of the tool result continuation.
    await Promise.resolve();
    samples.push(performance.now()-start);
  }
  const drainStart=performance.now();
  await writer.close();
  const drainMs=performance.now()-drainStart;
  const rows=fs.readFileSync(path.join(root,".gentle-graph","telemetry.jsonl"),"utf8").trim().split("\n");
  assert.equal(rows.length,samples.length);
  samples.sort((a,b)=>a-b);
  const p95=samples[Math.ceil(samples.length*.95)-1];
  console.log(JSON.stringify({samples:samples.length,p50Ms:samples[499],p95Ms:p95,maxMs:samples.at(-1),drainMs}));
  assert.ok(p95<1,"On-path logging p95 must be below 1 ms");
} finally {await writer.close(); fs.rmSync(root,{recursive:true,force:true});}
