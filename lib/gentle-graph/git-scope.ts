import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {rootLayout,trackedGuideChanges,verifiedCleanIndex,verifiedRacyFolders,type GitLayout} from "./clean-index.ts";
import {projectionArgs,projectionPattern} from "./git-projection.ts";
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

// Git for Windows exposes cmd/git.exe as a launcher. Use the sibling native
// executable only when the first git.exe on PATH belongs to that layout.
let resolvedGit:{searchPath:string;executable:string}|undefined;
function gitExecutable(){
  if(process.platform!=="win32")return "git";
  const searchPath=process.env.PATH??"";
  if(resolvedGit?.searchPath===searchPath)return resolvedGit.executable;
  let executable="git";
  for(const entry of searchPath.split(path.delimiter)){
    const dir=entry.replace(/^"|"$/g,"");
    if(!dir || !fs.existsSync(path.join(dir,"git.exe")))continue;
    if(path.basename(dir).toLowerCase()==="cmd"){
      const native=path.resolve(dir,"../mingw64/bin/git.exe");
      if(fs.existsSync(native))executable=native;
    }
    break;
  }
  resolvedGit={searchPath,executable};
  return executable;
}

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
  if(failure.code==="ENOENT"){
    let dir=path.resolve(root);
    while(!fs.existsSync(path.join(dir,".git"))){
      const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;
    }
    throw new GitScopeError(args[0],false);
  }
  // Keep the no-Git fallback explicit. A timeout, lock or corrupt index is
  // never permission to enumerate a potentially huge checkout on foot.
  if(failure.stderr?.toString().includes("not a git repository"))return null;
  throw new GitScopeError(args[0],failure.code==="ETIMEDOUT" || !!failure.killed);
}

function gitTextSync(root:string,args:string[],input?:string,timeout=4000):string|null {
  try {
    return execFileSync(gitExecutable(),args,{cwd:root,encoding:"utf8",windowsHide:true,timeout,
      maxBuffer:MAX_OUTPUT,input,stdio:[input===undefined?"ignore":"pipe","pipe","pipe"],env:gitEnv()});
  } catch(error) {return gitFailure(root,args,error);}
}

export function gitPathsSync(root:string,args:string[],_grep=false,input?:string,timeout=4000):string[]|null{
  return gitTextSync(root,args,input,timeout)?.split("\0").filter(Boolean)??null;
}

// Consistent diagnostic for gitFailure on localized hosts.
function gitEnv(){return {...process.env,LC_ALL:"C",GIT_OPTIONAL_LOCKS:"0"};}

type GitResult={status:"ok"|"not_git"|"git_error";paths:string[];error?:GitScopeError};
export async function gitPaths(root:string,args:string[],input?:string,timeout=4000):Promise<GitResult>{
  try{
    const paths=await executeGitPaths(root,args,input,timeout);
    return paths===null?{status:"not_git",paths:[]}:{status:"ok",paths};
  }catch(error){
    if(!(error instanceof GitScopeError))throw error;
    return {status:"git_error",paths:[],error};
  }
}
export async function requireGitPaths(root:string,args:string[],input?:string,timeout=4000){
  const result=await gitPaths(root,args,input,timeout);
  if(result.status==="git_error")throw result.error;
  return result.status==="ok"?result.paths:null;
}
async function executeGitPaths(root:string,args:string[],input?:string,timeout=4000):Promise<string[]|null>{
  const started=process.env.GENTLE_GRAPH_PROFILE==="1"?performance.now():undefined;
  try {
    const result=run(gitExecutable(),args,{cwd:root,encoding:"utf8",windowsHide:true,timeout,maxBuffer:MAX_OUTPUT,env:gitEnv()});
    result.child.stdin?.on("error",()=>{}).end(input);
    return (await result).stdout.split("\0").filter(Boolean);
  } catch(error){
    return gitFailure(root,args,error)===null?null:[];
  } finally {
    if(started!==undefined)console.error(JSON.stringify({graphProfile:"git",command:args[0],ms:performance.now()-started}));
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
  const layout = rootLayout(root);
  const before = layout && process.platform === "linux" ? fs.statSync(path.join(layout.dir,"index"),{bigint:true,throwIfNoEntry:false}) : undefined;
  const indexSecond=before ? Number(before.mtimeNs/1000000000n) : Infinity;
  let timestampTies=0;
  const offsets: number[] = [];
  let bytes: Buffer | undefined;
  const tracked = readTrackedIndexPaths(root, layout, process.platform === "linux" ? (_file, index, offset) => {
    bytes = index;
    offsets.push(offset);
    if(index.readUInt32BE(offset+8)>=indexSecond)timestampTies++;
  } : undefined);
  if (!tracked) return gitInventory(root);
  // For broad timestamp ties, native Git checks the worktree in parallel.
  // Reserve exact per-folder lstat checks for a small racy subset.
  const unchecked = timestampTies>0 && timestampTies<tracked.length/2 && layout && bytes && before && verifiedRacyFolders(root, layout, tracked, offsets, bytes);
  if (unchecked && layout) {
    const remaining = unchecked.length ? gitPathsSync(root, ["diff-files","--name-only","--no-renames","-z","--",...unchecked]) : [];

    const untracked = gitPathsSync(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    const staged = gitPathsSync(root, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--", "."]);
    const after = fs.statSync(path.join(layout.dir,"index"),{bigint:true,throwIfNoEntry:false});
    if (untracked && staged && remaining && before.ctimeNs === after?.ctimeNs && before.ino === after.ino) {
      return {files: untracked.length ? tracked.concat(untracked) : tracked, untracked, dirty: [...new Set([...staged,...remaining,...untracked])].filter(isIndexableFile)};
    }
  }
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

// Read the worktree once for both the target and the reverse-import projection.
export async function grepImpactProjection(root:string, term:string, trackedOnly=false){
  if(!/^[a-z][a-zA-Z0-9_]*$/.test(term))return null;
  const args=[...projectionArgs.slice(0,projectionArgs.indexOf("--")+1),...grepArgs.slice(grepArgs.indexOf("--")+1)];
  const search=trackedOnly ? args.filter(arg=>arg!=="--untracked") : args;
  const rows=await requireGitPaths(root,search,projectionPattern+term+"\n");
  if(!rows)return null;
  const hits=new Set<string>();
  const projection:string[]=[];
  let file=rows[0];
  for(const row of rows.slice(1)){
    const newline=row.indexOf("\n");
    if(newline<0) return null;
    const match=row.slice(0,newline).replace(/\r$/,"");
    if(match.includes(term) && isIndexableFile(file))hits.add(file);
    if((match[0]==="'" || match[0]==='"') && /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(file)){
      if(!projection.length)projection.push(file);
      else projection[projection.length-1]+=file;
      projection.push(match+"\n");
    }
    file=row.slice(newline+1);
  }
  return {hits:[...hits],projection};
}

// Searching the staged objects avoids opening every working file on NTFS.
// Only use these speculative hits after status confirms a clean tree and
// attributes confirm that checkout does not transform the searchable text.
export async function cleanLiteralHits(root:string,term:string,tracked:string[]){
  const [attributes,rows]=await Promise.all([
    requireGitPaths(root,["check-attr","-z","--all","--stdin"],tracked.join("\0")+"\0"),
    requireGitPaths(root,grepArgs.map(arg=>arg==="--untracked"?"--cached":arg),term+"\n")
  ]);
  if(!attributes || !rows)return null;
  for(let i=1;i<attributes.length;i+=3){
    if(["ident","filter","working-tree-encoding"].includes(attributes[i]))return null;
  }
  return rows.filter(isIndexableFile);
}

export interface GitSnapshot {
  root:string;
  key:string;
  dirty:string[];
  untracked?:string[];
  inventory?: Inventory;
  projection?: string[];
  greps:Map<string,string[]>;
  firstQuery?:string;
  results:Map<string,{text:string;mode:string;indexed:number;partial:boolean}>;
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

async function snapshotFromChanges(root:string,layout:GitLayout,files:string[],untracked:string[],staged:string[],changedOnDisk:string[]):Promise<[GitSnapshot,Inventory]|undefined>{
  const markers=controlFiles(root,layout);
  const head=fs.readFileSync(markers[0],"utf8").trimEnd();
  let oid=head;
  if(head.startsWith("ref: ")){
    try{oid=fs.readFileSync(markers.at(-1),"utf8").trimEnd();}catch{oid="";}
  }
  if(/^[0-9a-f]{40}$/.test(oid)){
    const changed=[...new Set([...untracked,...staged,...changedOnDisk])].filter(f=>!f.startsWith(".gentle-graph/") || f===".gentle-graph/guide.json");
    markers.push(...changed.map(f=>path.join(root,f)));
    const stamp=await metadata(markers);
    const key=createHash("sha256").update(oid).update(JSON.stringify(changed)).update(stamp).digest("hex");
    const inventory={files:[...files,...untracked],untracked};
    const state:GitSnapshot={root,key,dirty:changed.filter(isIndexableFile),inventory,greps:new Map(),results:new Map(),checkedAt:Date.now(),markers,stamp};
    layouts.set(root,layout);
    return [state,inventory];
  }
}

export function coldTrackedPaths(root:string,layout=rootLayout(root)){
  if(!layout || fs.existsSync(path.join(root,".gentle-graph","index.json")) ||
      fs.existsSync(path.join(root,".gentle-graph","index.sqlite")))return;
  return readTrackedIndexPaths(root,layout);
}

export async function prepareColdScope(root:string, inspectTerm?:string, impact=false):Promise<[GitSnapshot|null,Inventory|null]>{
  const layout=rootLayout(root);
  if(layout)layouts.set(root,layout);
  // Only a persisted graph needs a worktree-wide delta. Git's index supplies
  // tracked names for import resolution; enumerate just untracked paths in
  // parallel with the worktree search (including untracked callers and tests).
  if(inspectTerm && layout){
    const tracked=coldTrackedPaths(root,layout);
    if(tracked){
      const name=inspectTerm.split("#").at(-1) ?? inspectTerm;
      const projected=impact && /^[a-z][a-zA-Z0-9_]*$/.test(name) && fs.existsSync(path.join(root,"tsconfig.json"));
      // Git can search tracked working-tree bytes directly without its
      // untracked directory traversal. Include untracked source when present.
      const searchFiles=async(trackedOnly:boolean)=>{
        if(projected)return grepImpactProjection(root,name,trackedOnly);
        const args=trackedOnly?grepArgs.filter(arg=>arg!=="--untracked"):grepArgs;
        const rows=await requireGitPaths(root,args,name+"\n");
        return rows && {hits:rows.filter(isIndexableFile),projection:undefined};
      };
      const [untracked,trackedSearch]=await Promise.all([
        requireGitPaths(root,["ls-files","--others","--exclude-standard","-z","--","."]),
        searchFiles(true)
      ]);
      const search=untracked?.some(isIndexableFile)?await searchFiles(false):trackedSearch;
      if(untracked && search){
        const state=await snapshotFromChanges(root,layout,tracked,untracked,[],search.hits);
        if(state){
          const [snapshot]=state;
          snapshot.dirty=[];
          snapshot.firstQuery=JSON.stringify([impact?"impact":"inspect",inspectTerm]);
          snapshot.greps.set(JSON.stringify([name]),search.hits);
          snapshot.projection=search.projection;
          return state;
        }
      }
    }
  }
  // Git for Windows scans tracked and untracked entries in one status pass.
  // Avoid a second filesystem walk in Node and sequential fallbacks on NTFS.
  if(layout && process.platform==="win32"){
    const tracked=readTrackedIndexPaths(root,layout);
    if(tracked){
      const inventorySnapshot = async ():Promise<[GitSnapshot,Inventory]|undefined> => {
        // diff-files preloads tracked stats using Git's parallel index reader.
        // Keep untracked discovery independent of the tracked stat sweep.
        const [changed,untracked,staged]=await Promise.all([
          requireGitPaths(root,["diff-files","--name-only","--no-renames","-z","--","."]),
          requireGitPaths(root,["ls-files","--others","--exclude-standard","-z","--","."]),
          requireGitPaths(root,["diff","--cached","--name-only","--no-renames","-z","--","."])
        ]);
        if(!changed || !untracked || !staged)return;
        return snapshotFromChanges(root,layout,tracked,untracked,staged,changed);
      };
      if(!inspectTerm && !impact){
        const [trackedState,untracked,staged]=await Promise.all([
          trackedGuideChanges(root,layout,isIndexableFile),
          requireGitPaths(root,["ls-files","--others","--exclude-standard","-z","--","."]),
          requireGitPaths(root,["diff","--cached","--name-only","--no-renames","-z","--","."])
        ]);
        if(trackedState && untracked && staged){
          const prepared=await snapshotFromChanges(root,layout,trackedState.files,untracked,staged,trackedState.changed);
          if(prepared)return prepared;
        }
      }
      // A single unqualified lowercase-initial name is the first literal of
      // inspect. Overlap its read-only search with status on large worktrees.
      // Dirty snapshots use the normal search after status has settled.
      const simple = inspectTerm && /^[a-z][$\w]*$/.test(inspectTerm) && !inspectTerm.endsWith("Command");
      const projectImports=impact && fs.existsSync(path.join(root,"tsconfig.json"));
      // Search the bytes the parser sees, including smudged files. This
      // eliminates the separate check-attr pass over every tracked path.
      const combined=projectImports && simple && /^[a-z][a-zA-Z0-9_]*$/.test(inspectTerm!)
        ? grepImpactProjection(root,inspectTerm!,true).catch(()=>null) : undefined;
      // status reports staged, unstaged and untracked changes together. With
      // grep already scanning, avoid three competing Git processes on NTFS.
      const [state, hits, projection] = await Promise.all([
        inventorySnapshot().then(result=>result?.[0] ?? gitSnapshot(root)),
        combined ? combined.then(result=>result?.hits) : simple ? cleanLiteralHits(root,inspectTerm!,tracked).catch(()=>null) : null,
        combined ? combined.then(result=>result?.projection) : projectImports ? requireGitPaths(root, projectionArgs, projectionPattern).catch(() => null) : null
      ]);
      if (state && !state.dirty.length && projection) state.projection = projection;
      if (simple && state && !state.dirty.length && hits) {
        state.greps.set(JSON.stringify([inspectTerm]), hits);
      }
      if(state){
        const untracked=state.inventory?.untracked??state.untracked??[];
        const inventory={files:[...tracked,...untracked],untracked};
        state.inventory=inventory;
        return [state,inventory];
      }
    }
  }
  if(layout && process.platform!=="win32"){
    // All three operations are read-only and independent. The index validation
    // establishes clean tracked bytes. Git supplies staged and untracked changes.
    const [verified,untracked,staged]=await Promise.all([
      verifiedCleanIndex(root,layout),
      requireGitPaths(root,["ls-files","--others","--exclude-standard","-z","--","."]),
      requireGitPaths(root,["diff","--cached","--name-only","--no-renames","-z","--","."])
    ]);
    if(verified && untracked && staged){
      const {files,suspects}=verified;
      const changedOnDisk=suspects.length ? await requireGitPaths(root,["diff-files","--name-only","--no-renames","-z","--",...suspects.map(f=>":(literal)"+f)]) : [];
      if(changedOnDisk===null)return [null,null];
      const prepared=await snapshotFromChanges(root,layout,files,untracked,staged,changedOnDisk);
      if(prepared)return prepared;
    }
  }
  return Promise.all([gitSnapshot(root),gitSessionInventory(root,null)]);
}

export async function gitSnapshot(projectRoot:string,query?:string):Promise<GitSnapshot|null>{
  const root=path.resolve(projectRoot);
  const old=snapshots.get(root);
  // The TTL bounds discovery of previously clean or new paths. A modified
  // dirty file, branch/index change or manual guide edit invalidates immediately.
  if(old && (!old.firstQuery || old.firstQuery===query) && Date.now()-old.checkedAt<GIT_TTL_MS && await metadata(old.markers)===old.stamp)return old;
  const [rows,layout]=await Promise.all([
    requireGitPaths(root,["status","--branch","--no-ahead-behind","--porcelain=v2","-z","--no-renames","--untracked-files=all","--","."]),
    layouts.get(root)??requireGitPaths(root,layoutArgs).then(r=>rememberLayout(root,r?.join("")??null))
  ]);
  if(!rows || !layout)return null;
  const markers=controlFiles(root,layout);
  const hash=createHash("sha256"), dirty:string[]=[],untracked:string[]=[];
  for(const row of rows){
    if(row.startsWith("#")){hash.update(row).update("\0");continue;}
    const file=row.startsWith("? ")?row.slice(2):row.replace(/^(?:1 (?:\S+ ){7}|u (?:\S+ ){9})/,"");
    if(!file.startsWith(layout.prefix))continue;
    const rel=file.slice(layout.prefix.length);
    if(rel.startsWith(".gentle-graph/") && rel!==".gentle-graph/guide.json")continue;
    if(row.startsWith("? "))untracked.push(rel);
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
  const snapshot:GitSnapshot={root,key,dirty,untracked,markers,stamp,checkedAt:Date.now(),greps:new Map(),results:new Map()};
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
  const files=await requireGitPaths(root,["ls-files","--deduplicate","-z","--cached","--others","--exclude-standard","--","."]);
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
    const rows=await requireGitPaths(root,grepArgs,terms.join("\n")+"\n",timeout);
    if(rows===null)return null;
    files=rows.filter(isIndexableFile);
    if(snapshot){
      if(snapshot.greps.size>=96)snapshot.greps.delete(snapshot.greps.keys().next().value);
      snapshot.greps.set(key,files);
    }
  }
  return files.slice(0,maxFiles);
}
