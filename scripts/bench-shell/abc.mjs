import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync, spawnSync} from "node:child_process";
import {deviceSession, runPi} from "./abc-auth.mjs";
import {sessionMetrics} from "./session-metrics.mjs";
import {capturePatch, cleanWorktrees} from "./abc-worktree.mjs";
import {reportABC} from "./abc-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphRepo = path.resolve(here, "../..");
const graphSHA = "efeed94d8cf59ea65c7f26251b01551ed2fd29df";
const shellSHA = "c9b59eab57a56224c76b99e1caa9bb94cb113dc8";
const model = "openai-codex/gpt-6.2-sol";
const orders = ["ABC","BCA","CAB"];
const names = {A:"gs-base", B:"gs-codegraph", C:"gs-gentle-graph"};
const read = file => JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
const save = (file,value) => fs.writeFileSync(file,JSON.stringify(value,null,2));
const git = (root,...args) => execFileSync("git",["-C",root,...args],{windowsHide:true,encoding:"utf8",maxBuffer:64*1024*1024});
const run = (bin,args,options={}) => execFileSync(bin,args,{windowsHide:true,encoding:"utf8",...options}).trim();
const ps = (script,env=process.env) => run("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{env});
const isCG = n => /^(?:mcp__codegraph__|codegraph_)/i.test(n);
const isGG = n => n.startsWith("graph_");
function checkTools(state,arm) {
  const cg=state.active.some(n=>n.startsWith("mcp__codegraph__"));
  const gg=state.active.includes("graph_guide");
  return state.model===model && state.thinking==="high" && cg===(arm==="B") && gg===(arm==="C") &&
    (arm==="B" || !state.registered.some(isCG)) && (arm==="C" || !state.registered.some(isGG)) &&
    (arm!=="C" || ["graph_inspect","graph_impact","graph_register_pattern"].every(n=>state.registered.includes(n))) &&
    state.registered.some(n=>/^gentle_|^gentle-/.test(n));
}
function verify(cwd,env,args,file){
  const p=spawnSync(process.execPath,args,{cwd,env,windowsHide:true,encoding:"utf8",maxBuffer:64*1024*1024});
  fs.writeFileSync(file,[p.stdout,p.stderr,p.error].filter(Boolean).join("\n"));
  return p.status;
}

export function resolvePiRuntime(packagePath){
  const pkg=fs.realpathSync(packagePath);
  const metadata=read(path.join(pkg,"package.json"));
  if(metadata.name!=="@earendil-works/pi-coding-agent" || metadata.version!=="1.6.0")
    throw Error("Set GENTLE_ABC_PI_PACKAGE to the isolated @earendil-works/pi-coding-agent 1.6.0 package directory.");
  const bin=path.resolve(pkg,metadata.bin.pi);
  // The published CLI lives in dist/bundle. The OAuth wrapper needs the
  // unbundled modules alongside the SDK entry, independent of the bin layout.
  const dist=path.dirname(path.resolve(pkg,metadata.main));
  const cli=path.join(dist,"cli.js");
  for(const name of ["cli.js","cli/setup.js","main.js","core/auth-storage.js","core/model-runtime.js"])
    fs.accessSync(path.join(dist,name),fs.constants.R_OK);
  const pi=run(process.execPath,[bin,"--version"]);
  if(pi!=="1.6.0")throw Error("Unexpected Pi CLI version: "+pi);
  return {pkg,bin,cli,pi};
}

export async function runABC(argv){
  if(argv.includes("--help")){
    console.log("node scripts/bench-gentle-shell.mjs --abc SHELL_REPO [--preflight-only]\nRequires Windows, Node 24, installed Shell node_modules, Pi 1.6.0 (set GENTLE_ABC_PI_PACKAGE to an isolated pi-coding-agent package directory if needed), interactive Codex device authorization and a CodeGraph stdio entry in PI_CODING_AGENT_DIR/mcp.json or GENTLE_ABC_MCP_CONFIG.");
    return;
  }
  const only=argv.includes("--preflight-only");
  const positional=argv.filter(a=>a!=="--preflight-only");
  if(positional.length!==1 || process.platform!=="win32" || process.versions.node.split(".")[0]!=="24")
    throw Error("ABC requires Windows, Node 24 and the path to the Gentle Shell checkout; use --abc --help.");
  const repo=fs.realpathSync(positional[0]);
  for(const [root,sha] of [[repo,shellSHA],[graphRepo,graphSHA]]) git(root,"cat-file","-e",sha+"^{commit}");
  const modules=fs.realpathSync(process.env.GENTLE_ABC_MODULES || path.join(repo,"node_modules"));
  const ts=read(path.join(modules,"typescript/package.json")).version;
  if(ts!=="5.9.3")throw Error("Expected TypeScript 5.9.3 in "+modules);
  const {pkg,bin,cli,pi}=resolvePiRuntime(process.env.GENTLE_ABC_PI_PACKAGE || path.join(modules,"@earendil-works/pi-coding-agent"));
  const originalHome=process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(),".pi","agent");
  const configFile=process.env.GENTLE_ABC_MCP_CONFIG || path.join(originalHome,"mcp.json");
  if(!fs.existsSync(configFile))throw Error("Missing CodeGraph MCP configuration: "+configFile+
    ". Set GENTLE_ABC_MCP_CONFIG to a JSON file containing the working local mcpServers.codegraph entry.");
  const spec=read(configFile).mcpServers?.codegraph;
  if(!spec?.command || spec.url || spec.enabled===false || !Array.isArray(spec.args??[]))
    throw Error("Expected mcpServers.codegraph with an installed stdio command in "+configFile);
  if(Object.values(spec.env??{}).some(v=>typeof v!=="string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)))
    throw Error("Use environment-variable references in the CodeGraph config before saving benchmark evidence.");
  for(const arg of spec.args??[]){
    if(typeof arg!=="string")throw Error("CodeGraph args must be strings.");
    const value=arg.replace(/^--[^=]+=/,"");
    if(path.isAbsolute(value) && fs.statSync(value,{throwIfNoEntry:false})?.isDirectory())
      throw Error("Replace fixed repository directories in CodeGraph args with {worktree}.");
  }
  const binary=run("where.exe",["codegraph"]).split(/\r?\n/).find(p=>/\.(exe|cmd|bat)$/i.test(p));
  if(!binary)throw Error("codegraph is missing from PATH.");
  const cgVersion=ps("& $env:GENTLE_ABC_VERSION_BIN --version; exit $LASTEXITCODE",{...process.env,GENTLE_ABC_VERSION_BIN:binary});
  const documents=ps("[Environment]::GetFolderPath('MyDocuments')");
  if(!documents)throw Error("Windows Documents folder unavailable.");
  const parent=path.join(documents,"Gentle-Graph","benchmarks","abc-efeed94-c9b59ea");
  fs.mkdirSync(parent,{recursive:true});
  const out=fs.mkdtempSync(path.join(parent,new Date().toISOString().replace(/[:.]/g,"-")+"-"));
  console.log("ABC evidence:",out);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"gentle-abc-"));
  const worktrees=[];
  function checkout(root,dest,sha){
    git(root,"worktree","add","--detach","--quiet",dest,sha);
    worktrees.push([root,dest]);
    if(git(dest,"rev-parse","HEAD").trim()!==sha)throw Error("Unexpected HEAD at "+dest);
    fs.symlinkSync(modules,path.join(dest,"node_modules"),"junction");
  }
  const manifest={out,graphSHA,shellSHA,harnessSHA:git(graphRepo,"rev-parse","HEAD").trim(),model,thinking:"high",
    os:os.version()+" "+os.release()+" "+os.arch(),node:process.version,pi,piPackage:pkg,piBin:bin,piRuntime:cli,modules,typescript:ts,codegraph:cgVersion,binary,orders,arms:names,rows:[]};
  const environments=[];
  const retained=new Set();
  try{
    const engine=path.join(temp,"engine");
    checkout(graphRepo,engine,graphSHA);
    const accessForPi=await deviceSession(cli);
    const task=fs.readFileSync(path.join(engine,"scripts/bench-shell/task.txt"),"utf8");
    fs.writeFileSync(path.join(out,"task.txt"),task);
    for(const [r,order] of orders.entries())for(const arm of order){
      const id="r"+(r+1)+"-"+names[arm],cwd=path.join(temp,id);
      const folder=path.join(out,id),home=path.join(temp,id+"-home"),agent=path.join(home,".pi","agent");
      const sessions=path.join(folder,"sessions");
      fs.mkdirSync(sessions,{recursive:true});
      fs.mkdirSync(agent,{recursive:true});
      checkout(repo,cwd,shellSHA);
      save(path.join(agent,"settings.json"),{packages:[cwd]});
      const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,"Roaming"),LOCALAPPDATA:path.join(home,"Local"),
        PI_CODING_AGENT_DIR:agent,GENTLE_PI_AGENT_HOME:agent,GENTLE_PI_CONFIG_HOME:path.join(home,".pi","gentle-ai"),
        XDG_CONFIG_HOME:path.join(home,"config"),XDG_DATA_HOME:path.join(home,"data"),XDG_CACHE_HOME:path.join(home,"cache"),
        GENTLE_WORKTREE_ROOT:cwd,GENTLE_BENCH_THINKING:"high",GENTLE_ABC_ARM:arm,GENTLE_ABC_EVIDENCE:folder};
      delete env.GENTLE_SHELL_CHILD_PACKAGE_INJECTION;
      if(arm==="B"){
        const server={...spec,exposure:"direct",toolExposure:{"*":"direct"},cwd,
          args:(spec.args??[]).map(s=>s.replaceAll("{worktree}",cwd))};
        const config={mcpServers:{codegraph:server}};
        save(path.join(agent,"mcp.json"),config);
        save(path.join(folder,"mcp-config.json"),config);
      }
      if(fs.existsSync(path.join(cwd,".pi/mcp.json")))throw Error("Unexpected project MCP config at "+cwd);
      const args=["--model",model,"--thinking","high","--session-dir",sessions,"-e",path.join(here,"abc-capture.mjs")];
      if(arm==="C")args.push("-e",path.join(engine,"extensions/gentle-graph.ts"));
      const clean=verify(cwd,env,["scripts/check-types.mjs"],path.join(folder,"clean-typecheck.txt"));
      if(clean!==0)throw Error("Clean typecheck failed in "+folder);
      if(capturePatch(cwd).length)throw Error("Expected an empty patch during preflight at "+cwd);
      const cgDir=path.join(cwd,".codegraph");
      const setup=performance.now();
      if(arm==="B" && env.CODEGRAPH_PREPARE_ARGV){
        const [cmd,...params]=JSON.parse(env.CODEGRAPH_PREPARE_ARGV);
        run(cmd,params.map(s=>s.replaceAll("{worktree}",cwd)),{cwd,env});
      }
      const status=await runPi(cli,[...args,"--mode","rpc","--no-session"],cwd,{...env,GENTLE_ABC_PROBE:"1"},
        path.join(folder,"preflight.log"),await accessForPi(),true);
      if(status!==0)throw Error("Pi preflight failed at "+folder);
      const state=read(path.join(folder,"preflight-tools.json"));
      if(!state.available || !checkTools(state,arm))throw Error("Invalid model, reasoning, host or graph loadout at "+folder);
      save(path.join(folder,"preflight.json"),{sha:shellSHA,typescript:ts,cleanTypecheck:clean,arm,round:r+1,
        indexAfterPreflight:fs.existsSync(cgDir),setupArgv:arm==="B" && env.CODEGRAPH_PREPARE_ARGV?JSON.parse(env.CODEGRAPH_PREPARE_ARGV):null});
      environments.push({r:r+1,arm,cwd,folder,env,args,sessions,cgDir,initialized:fs.existsSync(cgDir),setupMs:performance.now()-setup});
    }
    manifest.preflight="passed";
    save(path.join(out,"summary.json"),manifest);
    if(only)return;
    for(const e of environments){
      const {cwd,env,folder,arm}=e;
      console.log("Round",e.r,names[arm]);
      const access=await accessForPi();
      const start=Date.now(),begin=performance.now();
      const exit=await runPi(cli,[...e.args,"-p",task],cwd,{...env,GENTLE_ABC_PROBE:"0"},path.join(folder,"agent-output.txt"),access);
      const elapsedMs=performance.now()-begin;
      retained.add(cwd);
      save(path.join(folder,"agent-timing.json"),{start,elapsedMs,agentExit:exit,cwd});
      const metric=sessionMetrics(e.sessions);
      const eventsFile=path.join(folder,"calls.jsonl");
      const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,"utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
      const tools={},nested={};
      for(const event of events){
        tools[event.tool]=(tools[event.tool]??0)+1;
        if(event.parent)nested[event.tool]=(nested[event.tool]??0)+1;
      }
      const activeFile=path.join(folder,"active-tools.json");
      const state=fs.existsSync(activeFile)?read(activeFile):null;
      const initializedAfter=fs.existsSync(e.cgDir);
      const tests=verify(cwd,env,["--test",path.join(engine,"scripts/bench-shell/verify.mjs")],path.join(folder,"verification-tests.txt"));
      const typecheck=verify(cwd,env,[path.join(modules,"typescript/bin/tsc"),"--noEmit","-p","tsconfig.json"],path.join(folder,"verification-tsc.txt"));
      const firstEdit=events.find(v=>v.tool==="edit");
      const row={round:e.r,arm,folder,tests,typecheck,agentExit:exit,elapsedMs,firstEditMs:firstEdit?firstEdit.time-start:null,
        patchBytes:null,turns:metric.turns,tokens:metric.measuredTurns===metric.turns && metric.turns?metric.tokens:null,
        ...metric.totals,tools,nested,searches:events.filter(v=>v.search||["grep","rg","find"].includes(v.tool)).length,
        graphUsed:Object.keys(tools).some(arm==="B"?isCG:isGG),setupMs:e.setupMs,codegraphBefore:e.initialized,codegraphAfter:initializedAfter,
        models:[...metric.models],thinking:state?.thinking};
      row.valid=false;
      manifest.rows.push(row);
      save(path.join(folder,"results.json"),row);
      reportABC(manifest);
      const patch=capturePatch(cwd);
      fs.writeFileSync(path.join(folder,"changes.patch"),patch);
      row.patchBytes=patch.length;
      row.valid=exit===0 && tests===0 && typecheck===0 && !!state && checkTools(state,arm) &&
        !metric.failedTurn && metric.models.size===1 && metric.models.has(model) && row.tokens>0;
      save(path.join(folder,"results.json"),row);
      reportABC(manifest);
      retained.delete(cwd);
    }
    if(manifest.rows.some(row=>!row.valid))process.exitCode=1;
  }catch(error){
    manifest.error=String(error);
    reportABC(manifest);
    throw error;
  }finally{
    const errors=await cleanWorktrees(worktrees,(root,cwd)=>git(root,"worktree","remove","--force",cwd),retained);
    if(!errors.length && !retained.size){
      try {fs.rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});}
      catch(error){errors.push({cwd:temp,error:String(error)});}
    }
    if(errors.length || retained.size){
      const cleanup={temp,retained:[...retained],errors};
      console.error("Benchmark cleanup:",cleanup);
      save(path.join(out,"cleanup.json"),cleanup);
      process.exitCode=1;
    }
  }
}
