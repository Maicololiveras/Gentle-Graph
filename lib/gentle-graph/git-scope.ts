import { execFileSync } from "node:child_process";
import { isIndexableFile, sourceExtensions } from "./languages/registry.ts";

function gitPathsSync(root: string, args: string[], grep = false, input?: string,timeout=4000): string[] | null {
  try {
    return execFileSync("git", args, {
      cwd: root, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024,
      input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true
    }).split("\0").filter(Boolean);
  } catch (error) {
    if (grep && (error as { status?: number }).status === 1) return [];
    return null;
  }
}

export function gitInventory(root: string) {
  const rows = gitPathsSync(root, ["ls-files", "-t", "--deduplicate", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
  if (!rows) return null;
  const files: string[] = [], untracked: string[] = [];
  for (const row of rows) {
    const file = row.slice(2);
    files.push(file);
    if (row[0] === "?") untracked.push(file);
  }
  return { files, untracked };
}

export function gitListIndexableFilesSync(root: string) {
  return gitInventory(root)?.files.filter(isIndexableFile) ?? null;
}

export function gitDirtyFilesSync(root: string, untracked?: string[]): string[] | null {
  const rows = gitPathsSync(root, ["status", "--porcelain=v1", "-z", "--no-renames",
    untracked ? "--untracked-files=no" : "--untracked-files=all", "--", "."]);
  if (!rows) return null;
  if (!rows.length) return untracked?.filter(isIndexableFile) ?? [];
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root, encoding: "utf8", timeout: 4000, windowsHide:true, stdio: ["ignore", "pipe", "pipe"]
    }).replace(/\r?\n$/, "");
    return rows.map(row => row.slice(3)).filter(file => file.startsWith(prefix))
      .map(file => file.slice(prefix.length)).concat(untracked ?? []).filter(isIndexableFile);
  } catch {
    return null;
  }
}

const grepArgs = ["grep", "--threads=1", "--untracked", "-I", "-z", "-l", "-F",
    "-f", "-", "--", ...sourceExtensions.map(ext => ":(glob,icase)**/*" + ext),
    ":(exclude,glob)**/.gentle-graph/**", ":(exclude,glob)**/node_modules/**"];

export function gitGrepFilesSync(root: string, literal: string | string[], maxFiles = 80, timeout=4000): string[] | null {
  const terms = typeof literal === "string" ? [literal] : literal;
  if (!terms.length) return [];
  const rows = gitPathsSync(root, grepArgs, true, terms.join("\n")+"\n",timeout);
  return rows?.filter(isIndexableFile).slice(0, maxFiles) ?? null;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const run = promisify(execFile);
export async function gitPaths(root:string,args:string[],input?:string,timeout=4000):Promise<string[]|null> {
  try {
    const result=run("git",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout,maxBuffer:32*1024*1024});
    // execFile doesn't forward an input option. Close stdin even for an empty frontier.
    result.child.stdin?.on("error",()=>{}).end(input);
    return (await result).stdout.split("\0").filter(Boolean);
  } catch(error) {
    if(args[0]==="grep" && (error as {code?:number}).code===1) return [];
    return null;
  }
}
export interface GitSnapshot {
  root:string; key:string; dirty:string[];
  inventory?: {files:string[];untracked:string[]};
  greps:Map<string,string[]>;
  results:Map<string,string>;
}
const snapshots=new Map<string,GitSnapshot>();
export function clearGitSession(){snapshots.clear();}
export async function gitSnapshot(root:string):Promise<GitSnapshot|null>{
  root=path.resolve(root);
  const [rows,prefixRows]=await Promise.all([
    gitPaths(root,["status","--branch","--no-ahead-behind","--porcelain=v2","-z","--no-renames","--untracked-files=all","--","."]),
    gitPaths(root,["rev-parse","--show-prefix"])
  ]);
  if(!rows || !prefixRows) return null;
  const prefix=prefixRows.join("").trimEnd();
  const hash=createHash("sha256"),dirty:string[]=[];
  for(const row of rows){
    if(row.startsWith("#")) { hash.update(row); continue; }
    const file=row.startsWith("? ")?row.slice(2):row.replace(/^(?:1 (?:\S+ ){7}|u (?:\S+ ){9})/,"");
    if(!file.startsWith(prefix)) continue;
    const rel=file.slice(prefix.length);
    if(rel.startsWith(".gentle-graph/") && rel!==".gentle-graph/guide.json") continue;
    hash.update(row).update("\0");
    const stat=fs.statSync(path.join(root,rel),{throwIfNoEntry:false,bigint:true});
    hash.update(String(stat?.mtimeNs)+":"+String(stat?.ctimeNs)+":"+String(stat?.size));
    if(isIndexableFile(rel))dirty.push(rel);
  }
  const guide=fs.statSync(path.join(root,".gentle-graph","guide.json"),{throwIfNoEntry:false,bigint:true});
  const key=hash.update(String(guide?.ctimeNs)).digest("hex");
  const old=snapshots.get(root);
  if(old?.key===key) return old;
  const snapshot:GitSnapshot={root,key,dirty,greps:new Map(),results:new Map()};
  snapshots.set(root,snapshot);
  return snapshot;
}
export async function gitListIndexableFiles(root:string,state?:GitSnapshot|null){
  const snapshot=state===undefined?await gitSnapshot(root):state;
  const inventory=await gitSessionInventory(root,snapshot);
  return inventory?.files.filter(isIndexableFile)??null;
}
export async function gitSessionInventory(root:string,snapshot:GitSnapshot|null){
  if(snapshot?.inventory)return snapshot.inventory;
  const files=await gitPaths(root,["ls-files","--deduplicate","-z","--cached","--others","--exclude-standard","--","."]);
  if(!files)return null;
  const inventory={files,untracked:[] as string[]};
  if(snapshot)snapshot.inventory=inventory;
  return inventory;
}
export async function gitDirtyFiles(root:string){return (await gitSnapshot(root))?.dirty??null;}
export async function gitGrepFiles(root:string,literal:string|string[],maxFiles=80,state?:GitSnapshot|null,timeout=4000){
  const terms=[...new Set(typeof literal==="string"?[literal]:literal)].sort();
  if(!terms.length)return [];
  const snapshot=state===undefined?await gitSnapshot(root):state;
  const key=JSON.stringify(terms);
  let files=snapshot?.greps.get(key);
  if(!files){
    const rows=await gitPaths(root,grepArgs,terms.join("\n")+"\n",timeout);
    if(rows===null)return null;
    files=rows.filter(isIndexableFile);
    if(snapshot){
      if(snapshot.greps.size>=96)snapshot.greps.delete(snapshot.greps.keys().next().value);
      snapshot.greps.set(key,files);
    }
  }
  return files.slice(0,maxFiles);
}
