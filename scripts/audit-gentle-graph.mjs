#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {parseArgs} from "node:util";

const {values,positionals} = parseArgs({allowPositionals:true,options:{
  telemetry:{type:"string",multiple:true}, out:{type:"string"}
}});
const sessionsDir = path.resolve(positionals[0] ?? "gentle-agents/sessions");
function lines(file) {
  const records = [];
  for (const line of fs.readFileSync(file,"utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { malformed++; }
  }
  return records;
}
function entries(dir,suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir,{withFileTypes:true}).filter(f=>f.isFile() && f.name.endsWith(suffix))
    .map(f=>path.join(dir,f.name));
}
if (!fs.existsSync(sessionsDir)) throw new Error("Session directory missing: "+sessionsDir);
let malformed = 0;
const tasks = new Map();
for (const file of entries(path.resolve(sessionsDir,"../tasks"),".json")) {
  try {
    const {task} = JSON.parse(fs.readFileSync(file,"utf8"));
    if (task?.sessionPath) tasks.set(path.resolve(task.sessionPath),task);
  } catch { malformed++; }
}

const sessions = new Map();
const events = new Map();
const roots = new Set([process.cwd()]);
const graph = name=>typeof name === "string" && name.startsWith("graph_");
const key = (session,id)=>JSON.stringify([session,id]);
function newSession(id) {
  if (!sessions.has(id)) sessions.set(id,{id,available:false,role:"unknown",root:null,calls:new Map()});
  return sessions.get(id);
}
function call(session,id,name,args,via) {
  if (!name || !id) return;
  const search = ["rg","grep"].includes(name) || (["bash","powershell"].includes(name) &&
    /\b(rg|grep|findstr|Select-String)\b/i.test(args?.command ?? ""));
  session.calls.set(id,{name,search,via});
}
for (const file of entries(sessionsDir,".jsonl")) {
  const records = lines(file);
  const header = records.find(r=>r.type==="session");
  const s = newSession(header?.id ?? file);
  const task = tasks.get(file);
  s.role = task?.agent ?? s.role;
  s.root = task?.cwd ?? header?.cwd ?? null;
  if (s.root) roots.add(s.root);
  for (const [i,r] of records.entries()) {
    const m = r.message ?? r;
    const added = r.toolsAdded ?? m.toolsAdded ?? r.data?.toolsAdded;
    if (Array.isArray(added) && added.some(t=>graph(t?.name ?? t))) s.available = true;
    const direct = m.role==="assistant" && Array.isArray(m.content) ? m.content.filter(c=>c.type==="toolCall") :
      r.toolCall ? [r.toolCall] : [];
    for (const [n,c] of direct.entries()) call(s,c.id ?? (i+"-"+n),c.name,c.arguments ?? c.args,false);
    for (const c of m.nestedCalls?.calls ?? []) call(s,c.id,c.name,c.arguments,m.toolName==="codemode" ? true : null);
    const event = m.details?.gentleGraph;
    if (event?.callId && event?.tool) events.set(key(event.sessionId ?? s.id,event.callId),{...event,sessionId:event.sessionId ?? s.id});
  }
}
const files = new Set();
for (const root of roots) {
  for (const name of ["telemetry.prev.jsonl","telemetry.jsonl"]) files.add(path.join(root,".gentle-graph",name));
}
for (const input of values.telemetry ?? []) {
  const file = path.resolve(input);
  if (!fs.existsSync(file)) throw new Error("Telemetry input missing: "+file);
  files.add(file);
}
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  for (const e of lines(file)) {
    if (!e.callId || !graph(e.tool)) continue;
    const sid = e.sessionId ?? "unknown@"+e.worktreeRoot;
    events.set(key(sid,e.callId),{...e,sessionId:sid});
  }
}
for (const e of events.values()) {
  const s = newSession(e.sessionId);
  if (s.role==="unknown") s.role = e.actorRole ?? "unknown";
  if (!s.calls.has(e.callId) || typeof e.viaCodemode==="boolean") call(s,e.callId,e.tool,undefined,e.viaCodemode);
}
function stats() {
  return {sessions:0,available:0,used:0,graph:0,direct:0,codemode:0,unknownRoute:0,read:0,search:0,
    hits:0,cacheSamples:0,partial:0,errors:0,matchingRoot:0,differentRoot:0,unknownRoot:0,boot:[],work:[]};
}
const groups = new Map(), total = stats();
function group(role,root) {
  const id = JSON.stringify([role,root]);
  if (!groups.has(id)) groups.set(id,{role,root,...stats()});
  return groups.get(id);
}
function addCall(g,s,id,c) {
  if(c.name==="read") g.read++;
  if(c.search) g.search++;
  if(!graph(c.name)) return;
  g.graph++;
  if(c.via===true) g.codemode++; else if(c.via===false) g.direct++; else g.unknownRoute++;
  const e = events.get(key(s.id,id));
  if (e && typeof e.cacheHit==="boolean") { g.cacheSamples++; if(e.cacheHit) g.hits++; }
  if (e?.partial) g.partial++;
  if (e?.error) g.errors++;
  if (Number.isFinite(e?.bootMs)) g.boot.push(e.bootMs);
  if (Number.isFinite(e?.workMs)) g.work.push(e.workMs);
  if (!s.root || !e?.worktreeRoot) g.unknownRoot++;
  else if (path.relative(s.root,e.worktreeRoot)==="") g.matchingRoot++;
  else g.differentRoot++;
}
for (const s of sessions.values()) {
  const contexts = new Map();
  for (const [id,c] of s.calls) {
    const root = events.get(key(s.id,id))?.worktreeRoot ?? s.root ?? "unknown";
    const g = group(s.role,root);
    contexts.set(g,contexts.get(g) || graph(c.name));
    addCall(g,s,id,c); addCall(total,s,id,c);
  }
  if (!contexts.size) contexts.set(group(s.role,s.root ?? "unknown"),false);
  function count(g,used) { g.sessions++; if(s.available || used) g.available++; if(used) g.used++; }
  for (const [g,used] of contexts) count(g,used);
  count(total,[...contexts.values()].some(Boolean));
}
function percentiles(values) {
  values.sort((a,b)=>a-b);
  return {samples:values.length,p50:values[Math.ceil(values.length*.5)-1] ?? null,p95:values[Math.ceil(values.length*.95)-1] ?? null};
}
function summarize({boot,work,...g}) {
  const ratio=(a,b)=>b ? a/b : null;
  return {...g,bootMs:percentiles(boot),workMs:percentiles(work),adoption:ratio(g.used,g.available),
    cacheHitRate:ratio(g.hits,g.cacheSamples),graphToRead:ratio(g.graph,g.read),graphToSearch:ratio(g.graph,g.search)};
}
const all = summarize(total);
const report = {sessionsDir,totalSessions:all.sessions,sessionsWithGraphAvailable:all.available,
  sessionsUsingGraph:all.used,totalGraphCalls:all.graph,totalGrepCalls:all.search,
  availabilityPct:(100*(all.sessions ? all.available/all.sessions : 0)).toFixed(1)+"%",
  adoptionPct:(100*(all.adoption ?? 0)).toFixed(1)+"%",malformed,total:all,byRoleAndWorktree:[...groups.values()].map(summarize)};
const json = JSON.stringify(report,null,2);
if (values.out) {
  fs.mkdirSync(values.out,{recursive:true});
  fs.writeFileSync(path.join(values.out,"audit.json"),json+"\n");
  const md=["# Gentle Graph adoption and latency","",
    "|Role / worktree|Sessions / available / used|Graph direct / codemode / unknown|Read / search|Graph:read / graph:search|Boot p50 / p95 ms|Work p50 / p95 ms|Cache hits / measured|Partial / errors|Root match / different / unknown|",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const fmt=v=>v==null?"—":Number(v.toFixed(2));
  for(const g of [all,...report.byRoleAndWorktree]){
    const title=g.role ? (g.role+" · "+g.root).replaceAll("|","\\|").replace(/[\r\n]/g," ") : "Total";
    md.push(`|${title}|${g.sessions} / ${g.available} / ${g.used}|${g.direct} / ${g.codemode} / ${g.unknownRoute}|${g.read} / ${g.search}|${fmt(g.graphToRead)} / ${fmt(g.graphToSearch)}|${fmt(g.bootMs.p50)} / ${fmt(g.bootMs.p95)}|${fmt(g.workMs.p50)} / ${fmt(g.workMs.p95)}|${g.hits} / ${g.cacheSamples}|${g.partial} / ${g.errors}|${g.matchingRoot} / ${g.differentRoot} / ${g.unknownRoot}|`);
  }
  md.push("", "An explicit projectRoot may explain a different root. Missing observations are reported as unknown.");
  fs.writeFileSync(path.join(values.out,"audit.md"),md.join("\n")+"\n");
}
console.log(json);
