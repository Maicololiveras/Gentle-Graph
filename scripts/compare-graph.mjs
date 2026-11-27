import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

const [repoArg, promptFile, model, output, ...verify] = process.argv.slice(2);
if (!output || !verify.length) throw new Error("Usage: node compare-graph.mjs REPO PROMPT_FILE PROVIDER/MODEL NEW_OUTPUT_DIR VERIFY_EXEC [ARGS...]");
const repo = path.resolve(repoArg);
const out = path.resolve(output);
const prompt = fs.readFileSync(promptFile, "utf8");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64*1024*1024 });
const sha = git(repo, "rev-parse", "HEAD").trim();
const extension = fileURLToPath(new URL("../extensions/gentle-graph.ts", import.meta.url));
fs.mkdirSync(out);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-ab-"));
const codegraph = process.env.CODEGRAPH_PI_EXTENSION ? fs.realpathSync(process.env.CODEGRAPH_PI_EXTENSION) : undefined;
const prepareCodegraph = process.env.CODEGRAPH_PREPARE_ARGV ? JSON.parse(process.env.CODEGRAPH_PREPARE_ARGV) : [];
if (!Array.isArray(prepareCodegraph) || !prepareCodegraph.every(a=>typeof a === "string")) throw new Error("CODEGRAPH_PREPARE_ARGV must be a JSON string array");
const arms = codegraph ? ["graph","baseline","codegraph"] : ["graph","baseline"];
if (process.env.GENTLE_BENCH_FIRST && !codegraph) {
  if (!["baseline","graph"].includes(process.env.GENTLE_BENCH_FIRST)) throw new Error("Invalid first arm");
  arms.sort((a,b)=>Number(b===process.env.GENTLE_BENCH_FIRST)-Number(a===process.env.GENTLE_BENCH_FIRST));
} else for (let i=arms.length-1; i>0; i--) {
  const j = randomInt(i+1);
  [arms[i],arms[j]] = [arms[j],arms[i]];
}
const results = {};
fs.writeFileSync(path.join(out, "prompt.txt"), prompt);
try {
  for (const arm of arms) {
    const folder = path.join(out, arm);
    fs.mkdirSync(folder);
    const cwd = path.join(temp, arm);
    git(repo, "worktree", "add", "--quiet", "--detach", cwd, sha);
    try {
      const sessions = path.join(folder, "sessions");
      fs.mkdirSync(sessions);
      const args = ["--no-extensions","--no-mcp","--no-skills","--no-prompt-templates","--model",model,"--session-dir",sessions];
      const capture = path.join(folder,"capture.mjs");
      const toolsFile = path.join(folder,"tools.json");
      fs.writeFileSync(capture,`import fs from "node:fs"; export default function(pi) { pi.on("before_agent_start",()=>{fs.writeFileSync(${JSON.stringify(toolsFile)},JSON.stringify(pi.getActiveTools()))});
const started=new Map();
pi.on("tool_execution_start",e=>{started.set(e.toolCallId,performance.now())});
pi.on("tool_execution_end",e=>{const start=started.get(e.toolCallId); if(start!==undefined){fs.appendFileSync(${JSON.stringify(path.join(folder,"tool-times.jsonl"))},JSON.stringify({tool:e.toolName,ms:performance.now()-start,error:!!e.isError})+"\\n"); started.delete(e.toolCallId)}}); }`);
      args.push("-e",capture);
      let setupMs = 0;
      if (arm === "codegraph") {
        args.push("-e",codegraph);
        if (prepareCodegraph.length) {
          const started = performance.now();
          execFileSync(prepareCodegraph[0],prepareCodegraph.slice(1),{cwd,stdio:"pipe"});
          setupMs = performance.now()-started;
        }
      }
      if (arm === "graph") args.push("-e", extension);
      const pi = process.env.PI_CLI_JS;
      const start = performance.now();
      const agent = spawnSync(pi ? process.execPath : "pi", [...(pi ? [pi] : []), ...args, "-p", prompt], { cwd, encoding:"utf8", maxBuffer:32*1024*1024 });
      const elapsedMs = performance.now()-start;
      fs.writeFileSync(path.join(folder,"answer.txt"), agent.stdout ?? "");
      fs.writeFileSync(path.join(folder,"agent-stderr.txt"), agent.stderr ?? String(agent.error ?? ""));
      // Include added source files in the review patch, excluding the graph's generated cache.
      git(cwd,"add","-N","--",".",":(exclude).gentle-graph");
      const patch = git(cwd,"diff","HEAD","--",".",":(exclude).gentle-graph");
      fs.writeFileSync(path.join(folder,"changes.patch"),patch);
      const verifyStart = performance.now();
      const check = spawnSync(verify[0], verify.slice(1), {cwd, encoding:"utf8",maxBuffer:32*1024*1024});
      fs.writeFileSync(path.join(folder,"verification.txt"), [check.stdout,check.stderr,check.error].filter(Boolean).join("\n"));
      const verificationMs = performance.now()-verifyStart;
      const totals = { input:0, output:0, cacheRead:0, cacheWrite:0, costUSD:0 };
      const models = new Set();
      let failedTurn = false;
      let turns = 0, measuredTurns = 0, tokens = 0;
      const calls = {};
      for (const file of fs.readdirSync(sessions,{recursive:true}).filter(f => f.endsWith(".jsonl"))) {
        for (const line of fs.readFileSync(path.join(sessions,file),"utf8").split(/\r?\n/).filter(Boolean)) {
          const msg = JSON.parse(line).message;
          if (msg?.role !== "assistant") continue;
          turns++;
          if (msg.model) models.add([msg.provider,msg.model].filter(Boolean).join("/"));
          if (["error","aborted"].includes(msg.stopReason)) failedTurn = true;
          for (const key of Object.keys(totals)) {
            const value = key === "costUSD" ? msg.usage?.cost?.total : msg.usage?.[key];
            if (!Number.isFinite(value) || totals[key] === null) totals[key] = null;
            else totals[key] += value;
          }
          if (Number.isFinite(msg.usage?.totalTokens) && msg.usage.totalTokens > 0) { measuredTurns++; tokens += msg.usage.totalTokens; }
          for (const item of Array.isArray(msg.content) ? msg.content : []) if (item.type === "toolCall") calls[item.name] = (calls[item.name] ?? 0)+1;
        }
      }
      const activeTools = fs.existsSync(toolsFile) ? JSON.parse(fs.readFileSync(toolsFile,"utf8")) : [];
      if (!activeTools.length || (arm==="graph" && !activeTools.includes("graph_inspect")) || (arm==="baseline" && activeTools.includes("graph_inspect"))) process.exitCode = 1;
      if (!turns) for (const key of Object.keys(totals)) totals[key]=null;
      if (totals.costUSD === 0) totals.costUSD = null;
      results[arm] = { ...totals, models:[...models], failedTurn, verificationMs, agentExit:agent.status, setupMs, activeTools, elapsedMs, calls, turns, tokens: turns && measuredTurns === turns ? tokens : null, verificationExit:check.status,
        qualityReview:null, reusedSymbols:null, duplicatedBlocks:null };
      if (failedTurn || agent.status !== 0 || !turns || check.status !== 0 || (arm === "baseline" && Object.keys(calls).some(k=>k.startsWith("graph_")))) process.exitCode = 1;
      fs.writeFileSync(path.join(out,"results.json"),JSON.stringify({sha,model,order:arms,verify,results},null,2));
    } finally { git(repo,"worktree","remove","--force",cwd); }
  }
  if (codegraph && !results.codegraph?.activeTools.some(tool=>!results.baseline.activeTools.includes(tool))) {
    console.error("Invalid CodeGraph arm: no additional active tool was observed");
    process.exitCode = 1;
  }
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
