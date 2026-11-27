import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {readTrackedIndexPaths} from "./git-index-paths.ts";
import { isIndexableFile, sourceExtensions } from "./languages/registry.ts";

const run = promisify(execFile);
const MAX_OUTPUT = 32 * 1024 * 1024;
const GIT_TTL_MS = 2000;
const grepArgs = ["grep", "--untracked", "-I", "-z", "-l", "-F", "-f", "-", "--",
  ...sourceExtensions.map(ext => ":(glob,icase)**/*" + ext),
  ":(exclude,glob)**/.gentle-graph/**", ":(exclude,glob)**/node_modules/**"];
const layoutArgs = ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-prefix"];

type GitLayout = { dir:string; common:string; prefix:string };
type Inventory = { files:string[]; untracked:string[]; dirty?:string[] };
type GitFailure = { code?:string|number; status?:number; killed?:boolean; stderr?:string|Buffer };
export class GitScopeError extends Error {
  readonly timedOut:boolean;
  constructor(command:string,timedOut:boolean) {
    super("Git " + command + (timedOut ? " timed out" : " failed") + "; retry the graph query.");
    this.timedOut=timedOut;
  }
}

const layouts = new Map<string,GitLayout>();
function gitFailure(root:string, args:string[], failure:GitFailure):null|string {
  if(args[0]==="grep" && (failure.status===1 || failure.code===1))return "";
  if(failure.code==="ENOENT")return null;
  // Keep the no-Git fallback explicit. A timeout, lock or corrupt index is
  // never permission to enumerate a potentially huge checkout on foot.
  if(failure.stderr?.toString().includes("not a git repository"))return null;
  throw new GitScopeError(args[0],failure.code==="ETIMEDOUT" || !!failure.killed);
}

function gitTextSync(root:string,args:string[],input?:string,timeout=4000):string|null {
  try {
    return execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout,
      maxBuffer:MAX_OUTPUT,input,stdio:[input===undefined?"ignore":"pipe","pipe","pipe"],env:gitEnv()});
  } catch(error) {return gitFailure(root,args,error);}
}

export function gitPathsSync(root:string,args:string[],_grep=false,input?:string,timeout=4000):string[]|null{
  return gitTextSync(root,args,input,timeout)?.split("\0").filter(Boolean)??null;
}

// Consistent diagnostic for gitFailure on localized hosts.
function gitEnv(){return {...process.env,LC_ALL:"C"};}

export async function gitPaths(root:string,args:string[],input?:string,timeout=4000):Promise<string[]|null>{
  try {
    const result=run("git",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout,maxBuffer:MAX_OUTPUT,env:gitEnv()});
    result.child.stdin?.on("error",()=>{}).end(input);
    return (await result).stdout.split("\0").filter(Boolean);
  } catch(error){
    return gitFailure(root,args,error)===null?null:[];
  }
}

function rememberLayout(root:string,output:string|null):GitLayout|null {
  if(output===null)return null;
  const [dir,common,prefix]=output.replace(/\r?\n$/, "").split(/\r?\n/);
  if(!dir || !common || prefix===undefined)throw new GitScopeError("rev-parse",false);
  const layout={dir,common,prefix};
  layouts.set(path.resolve(root),layout);
  return layout;
}

export function gitInventory(root:string):Inventory|null {
  const rows=gitTextSync(root,["ls-files","-t","--deduplicate","-z","--cached","--others","--exclude-standard","--","."]);
  if(rows===null)return null;
  const files:string[]=[], untracked:string[]=[];
  for(let start=0,end=rows.indexOf("\0");end>=0;start=end+1,end=rows.indexOf("\0",start)){
    const file=rows.slice(start+2,end);
    files.push(file);
    if(rows[start]==="?")untracked.push(file);
  }
  return {files,untracked};
}

export function gitWorkspaceInventory(root: string): Inventory | null {
  const tracked = readTrackedIndexPaths(root);
  if (!tracked) return gitInventory(root);
  const rows = gitPathsSync(root, ["status","--porcelain=v1","-z","--no-renames","--untracked-files=all","--","."]);
  if (rows === null) return null;
  const dirty: string[] = [], untracked: string[] = [];
  for (const row of rows) {
    const file = row.slice(3);
    if (row.startsWith("?? ")) untracked.push(file);
    if (isIndexableFile(file)) dirty.push(file);
  }
  return {files: untracked.length ? untracked.concat(tracked) : tracked, untracked, dirty};
}

export function gitListIndexableFilesSync(root:string){
  return gitInventory(root)?.files.filter(isIndexableFile)??null;
}

export function gitDirtyFilesSync(root:string,untracked?:string[]):string[]|null {
  const rows=gitTextSync(root,["status","--porcelain=v1","-z","--no-renames",
    untracked?"--untracked-files=no":"--untracked-files=all","--","."]);
  if(rows===null)return null;
  if(!rows)return untracked?.filter(isIndexableFile)??[];
  const layout=layouts.get(path.resolve(root))??rememberLayout(root,gitTextSync(root,layoutArgs));
  if(!layout)return null;
  return rows.split("\0").filter(Boolean).map(row=>row.slice(3)).filter(file=>file.startsWith(layout.prefix))
    .map(file=>file.slice(layout.prefix.length)).concat(untracked??[]).filter(isIndexableFile);
}

export function gitGrepFilesSync(root:string,literal:string|string[],maxFiles=80,timeout=4000):string[]|null{
  const terms=typeof literal==="string"?[literal]:literal;
  if(!terms.length)return [];
  const rows=gitTextSync(root,grepArgs,terms.join("\n")+"\n",timeout);
  return rows?.split("\0").filter(isIndexableFile).slice(0,maxFiles)??null;
}

export interface GitSnapshot {
  root:string;
  key:string;
  dirty:string[];
  inventory?: Inventory;
  greps:Map<string,string[]>;
  results:Map<string,string>;
  checkedAt:number;
  markers:string[];
  stamp:string;
}
const snapshots=new Map<string,GitSnapshot>();
export function adoptGitSnapshot(state:GitSnapshot){snapshots.set(state.root,state);}
export function clearGitSession(){snapshots.clear();layouts.clear();}

function controlFiles(root:string,layout:GitLayout):string[]{
  const head=path.join(layout.dir,"HEAD");
  const files=[head,path.join(layout.dir,"index"),path.join(layout.common,"packed-refs"),path.join(root,".gentle-graph","guide.json")];
  try{
    const ref=fs.readFileSync(head,"utf8").trimEnd();
    if(ref.startsWith("ref: "))files.push(path.join(layout.common,ref.slice(5)));
  }catch{/* Missing HEAD will be revisited by status. */}
  return files;
}
async function metadata(files:string[]):Promise<string>{
  const hash=createHash("sha256");
  // Keep concurrent reads bounded even in a checkout with thousands of edits.
  for(let start=0;start<files.length;start+=32){
    const stamps=await Promise.all(files.slice(start,start+32).map(async file=>{
      try {
        const stat=await fs.promises.lstat(file,{bigint:true});
        return stat.mtimeNs+":"+stat.ctimeNs+":"+stat.size+";";
      } catch(error) {
        const code=(error as NodeJS.ErrnoException).code;
        if(code==="ENOENT" || code==="ENOTDIR")return "-;";
        throw error;
      }
    }));
    hash.update(stamps.join(""));
  }
  return hash.digest("hex");
}

export async function gitSnapshot(projectRoot:string):Promise<GitSnapshot|null>{
  const root=path.resolve(projectRoot);
  const old=snapshots.get(root);
  // The TTL bounds discovery of previously clean or new paths. A modified
  // dirty file, branch/index change or manual guide edit invalidates immediately.
  if(old && Date.now()-old.checkedAt<GIT_TTL_MS && await metadata(old.markers)===old.stamp)return old;
  const [rows,layout]=await Promise.all([
    gitPaths(root,["status","--branch","--no-ahead-behind","--porcelain=v2","-z","--no-renames","--untracked-files=all","--","."]),
    layouts.get(root)??gitPaths(root,layoutArgs).then(r=>rememberLayout(root,r?.join("")??null))
  ]);
  if(!rows || !layout)return null;
  const markers=controlFiles(root,layout);
  const hash=createHash("sha256"), dirty:string[]=[];
  for(const row of rows){
    if(row.startsWith("#")){hash.update(row).update("\0");continue;}
    const file=row.startsWith("? ")?row.slice(2):row.replace(/^(?:1 (?:\S+ ){7}|u (?:\S+ ){9})/,"");
    if(!file.startsWith(layout.prefix))continue;
    const rel=file.slice(layout.prefix.length);
    if(rel.startsWith(".gentle-graph/") && rel!==".gentle-graph/guide.json")continue;
    hash.update(row).update("\0");
    markers.push(path.join(root,rel));
    if(isIndexableFile(rel))dirty.push(rel);
  }
  const stamp=await metadata(markers);
  const key=hash.update(stamp).digest("hex");
  if(old?.key===key){
    old.checkedAt=Date.now();
    return old;
  }
  const snapshot:GitSnapshot={root,key,dirty,markers,stamp,checkedAt:Date.now(),greps:new Map(),results:new Map()};
  snapshots.set(root,snapshot);
  return snapshot;
}

export async function gitListIndexableFiles(root:string,state?:GitSnapshot|null){
  const snapshot=state===undefined?await gitSnapshot(root):state;
  const inventory=await gitSessionInventory(root,snapshot);
  return inventory?.files.filter(isIndexableFile)??null;
}
export async function gitSessionInventory(root:string,snapshot:GitSnapshot|null):Promise<Inventory|null>{
  if(snapshot?.inventory)return snapshot.inventory;
  const files=await gitPaths(root,["ls-files","--deduplicate","-z","--cached","--others","--exclude-standard","--","."]);
  if(!files)return null;
  const inventory={files,untracked:[]};
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
