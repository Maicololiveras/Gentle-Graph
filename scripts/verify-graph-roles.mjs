// Validate real child transcripts from two concurrent worktrees against known, distinct source symbols.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const matrix = JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
assert.equal(matrix.length,2);
const roles = ["explore","worker","verify","jd-fix-agent","jd-judge-a","jd-judge-b"];
const evidence = [];
const seen = new Set();
assert.notEqual(fs.realpathSync(matrix[0].root),fs.realpathSync(matrix[1].root));
assert.notEqual(matrix[0].symbol,matrix[1].symbol);
for (const [n, tree] of matrix.entries()) {
  for (const role of roles) {
    const file = fs.realpathSync(tree.sessions[role]);
    assert(!seen.has(file),"Reused transcript: "+file);
    seen.add(file);
    const records = fs.readFileSync(file,"utf8").trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const header = records.find(r=>r.type==="session");
    assert.equal(fs.realpathSync(header.cwd),fs.realpathSync(tree.root),file);
    const messages = records.map(r=>r.message).filter(Boolean);
    const ids = messages.filter(m=>m.role==="assistant").flatMap(m=>Array.isArray(m.content)?m.content:[])
      .filter(c=>c.type==="toolCall" && c.name==="graph_inspect" && c.arguments?.symbol===tree.symbol && !c.arguments.projectRoot).map(c=>c.id);
    const hit = messages.find(m=>m.role==="toolResult" && ids.includes(m.toolCallId) && !m.isError &&
      m.content?.some(c=>c.type==="text" && c.text.includes(tree.marker) && !c.text.includes(matrix[1-n].marker)));
    assert(hit,role+" missing matching graph_inspect evidence in "+file);
    const times = messages.map(m=>m.timestamp).filter(Number.isFinite);
    assert(times.length>1,file);
    evidence.push({role,tree:n,start:Math.min(...times),end:Math.max(...times)});
  }
}
assert.notEqual(matrix[0].marker,matrix[1].marker);
for (const role of roles) {
  const [a,b] = evidence.filter(e=>e.role===role);
  assert(Math.max(a.start,b.start)<Math.min(a.end,b.end),role+" sessions did not overlap");
}
console.log(JSON.stringify(evidence,null,2));
