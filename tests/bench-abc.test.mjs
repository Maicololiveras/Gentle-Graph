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
