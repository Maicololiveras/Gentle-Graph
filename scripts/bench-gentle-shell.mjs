import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
if (process.argv[2] === "--abc") {
  const {runABC} = await import("./bench-shell/abc.mjs");
  await runABC(process.argv.slice(3));
} else {
const [repoArg,model,pairsArg="1",outArg] = process.argv.slice(2);
const pairs=Number(pairsArg);
if (!repoArg || !model || !Number.isSafeInteger(pairs) || pairs<1 || !model.includes("/")) throw new Error("Usage: node scripts/bench-gentle-shell.mjs SHELL_REPO PROVIDER/MODEL PAIRS [NEW_OUTPUT_DIR]");
const repo=fs.realpathSync(repoArg);
const dir=path.dirname(fileURLToPath(import.meta.url));
const git=(...args)=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
const sha=git("rev-parse","HEAD");
for (const f of ["lib/agent-tool-overlay.ts","lib/agents-config.ts"]) git("cat-file","-e","HEAD:"+f);
if (git("show","HEAD:lib/agent-tool-overlay.ts").includes("loadToolOverlayForAgent")) throw new Error("The selected commit already contains the benchmark feature.");
const env={...process.env};
env.GENTLE_BENCH_THINKING ??= "high";
delete env.CODEGRAPH_PI_EXTENSION;
delete env.CODEGRAPH_PREPARE_ARGV;
if (!env.PI_CLI_JS) {
  const pkg=path.join(repo,"node_modules/@earendil-works/pi-coding-agent/package.json");
  if (fs.existsSync(pkg)) env.PI_CLI_JS=path.resolve(path.dirname(pkg),JSON.parse(fs.readFileSync(pkg,"utf8")).bin.pi);
}
if (env.PI_CLI_JS) env.PI_CLI_JS=fs.realpathSync(env.PI_CLI_JS);
env.GENTLE_BENCH_MODULES=path.join(repo,"node_modules");
if (!fs.existsSync(path.join(env.GENTLE_BENCH_MODULES,"typescript/bin/tsc"))) throw new Error("Install the dependencies of this Gentle Shell checkout before running a paid pair.");
const tsPackage=path.join(env.GENTLE_BENCH_MODULES,"typescript/package.json");
if (JSON.parse(fs.readFileSync(tsPackage,"utf8")).version!=="5.9.3")
  throw new Error("This benchmark requires the host TypeScript 5.9.3 in both arms.");
const cli = env.PI_CLI_JS ? process.execPath : "pi";
const pre=spawnSync(cli,[...(env.PI_CLI_JS?[env.PI_CLI_JS]:[]),"--version"],{encoding:"utf8"});
if (pre.status!==0) throw new Error("Pi unavailable. Install the repo prerequisites or set PI_CLI_JS to the absolute JS entry of your authenticated Pi installation.");
const out=outArg?path.resolve(outArg):fs.mkdtempSync(path.join(os.tmpdir(),"gentle-shell-bench-"));
if(outArg) fs.mkdirSync(out);
const report={version:2,sha,model,thinking:env.GENTLE_BENCH_THINKING,node:process.version,pi:pre.stdout.trim(),platform:process.platform,pairs:[],out};
const first=randomInt(2);
const metrics=["tokens","input","output","cacheRead","cacheWrite","costUSD","elapsedMs","verificationMs","turns","toolCalls","searchCalls"];
console.log("Results:",out);
for(let i=0;i<pairs;i++){
  if(git("rev-parse","HEAD")!==sha) throw new Error("HEAD changed during benchmark");
  const dest=path.join(out,"pair-"+(i+1));
  env.GENTLE_BENCH_FIRST=(i+first)%2?"baseline":"graph";
  console.log("Pair",i+1,"of",pairs,"first:",env.GENTLE_BENCH_FIRST);
  const run=spawnSync(process.execPath,[path.join(dir,"compare-graph.mjs"),repo,path.join(dir,"bench-shell/task.txt"),model,dest,process.execPath,path.join(dir,"bench-shell/quality.mjs")],{env,stdio:"inherit"});
  const file=path.join(dest,"results.json");
  if(!fs.existsSync(file)) throw new Error("Incomplete pair: "+dest);
  const {results,order}=JSON.parse(fs.readFileSync(file,"utf8"));
  const a=results.baseline,b=results.graph;
  for(const arm of [a,b]) arm.toolCalls=Object.values(arm.calls).reduce((x,y)=>x+y,0);
  const used=Object.keys(b.calls).some(tool=>tool.startsWith("graph_"));
  const extra=b.activeTools.filter(t=>!a.activeTools.includes(t));
  const toolsOK=extra.includes("graph_inspect") && extra.every(t=>t.startsWith("graph_")) && a.activeTools.every(t=>!t.startsWith("graph_") && b.activeTools.includes(t));
  const eligible=run.status===0 && a.tokens>0 && b.tokens>0 && toolsOK && a.models.length===1 && a.models[0]===model && String(a.models)===String(b.models) && a.thinking===report.thinking && b.thinking===report.thinking;
  const rows=Object.fromEntries(metrics.map(k=>[k,{baseline:a[k],graph:b[k],reductionPct:a[k]>0 && Number.isFinite(b[k])?+(100*(a[k]-b[k])/a[k]).toFixed(2):null}]));
  report.pairs.push({order,eligible,used,toolsOK,models:[a.models,b.models],verification:[a.verificationExit,b.verificationExit],rows});
  const valid=report.pairs.filter(p=>p.eligible);
  report.validPairs=valid.length;
  report.combinedReductionPct=Object.fromEntries(metrics.map(k=>{
    if(!valid.length || valid.some(p=>![p.rows[k].baseline,p.rows[k].graph].every(Number.isFinite))) return [k,null];
    const base=valid.reduce((s,p)=>s+p.rows[k].baseline,0),graph=valid.reduce((s,p)=>s+p.rows[k].graph,0);
    return [k,base>0?+(100*(1-graph/base)).toFixed(2):null];
  }));
  const improved=eligible && b.tokens<a.tokens && b.elapsedMs<a.elapsedMs;
  report.pairs.at(-1).improved=improved;
  report.verdict=!eligible?"invalid":!improved?"failed":i+1<pairs?"running":i+1<2?"pilot-pass":"passed";
  const table=["| Indicador | Base | Grafo | Diferencia B−A | Ahorro % |","|---|---:|---:|---:|---:|",
    ...Object.entries(rows).map(([k,v])=>"| "+[k,v.baseline??"N/D",v.graph??"N/D",Number.isFinite(v.graph)&&Number.isFinite(v.baseline)?v.graph-v.baseline:"N/D",v.reductionPct??"N/D"].join(" | ")+" |")];
  const toolTable=["| Herramienta | Base | Grafo |","|---|---:|---:|",
    ...[...new Set([...Object.keys(a.calls),...Object.keys(b.calls)])].sort().map(name=>"| "+[name,a.calls[name]??0,b.calls[name]??0].join(" | ")+" |")];
  fs.appendFileSync(path.join(out,"informe-ab.md"),["## Par "+(i+1),"","Resultado: "+report.verdict+". Uso observado del grafo: "+used+".", "",...table,"",...toolTable,"","Verificación, transcripciones y parches en pair-"+(i+1)+".",""].join("\n"));
  fs.writeFileSync(path.join(out,"summary.json"),JSON.stringify(report,null,2));
  console.table(rows);
  if(!improved) { console.error("Quality or performance gate failed. Check results.json, verification.txt and agent-stderr.txt before spending more.");process.exitCode=1;break; }
}
console.log("Summary:",path.join(out,"summary.json"));
}
