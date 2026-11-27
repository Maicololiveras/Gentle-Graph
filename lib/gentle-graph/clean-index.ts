// A freshly populated worktree can make Git compare thousands of blobs that
// share the index's second. Certify only entries with precise kernel timestamps
// predating the index. Git handles ties, coarse timestamps and other formats.
import fs from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {readTrackedIndexPaths} from "./git-index-paths.ts";

export type GitLayout = {dir:string; common:string; prefix:string};
export function rootLayout(root:string):GitLayout|undefined{
  if(process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE)return;
  try{
    let dir=path.join(root,".git");
    const marker=fs.lstatSync(dir,{throwIfNoEntry:false});
    if(marker?.isFile()){
      const pointer=fs.readFileSync(dir,"utf8").trimEnd();
      if(!pointer.startsWith("gitdir: "))return;
      dir=path.resolve(root,pointer.slice(8));
    }else if(!marker?.isDirectory())return;
    const commonPath=path.join(dir,"commondir");
    const common=fs.existsSync(commonPath)?path.resolve(dir,fs.readFileSync(commonPath,"utf8").trimEnd()):dir;
    return {dir,common,prefix:""};
  }catch{return;}
}

export async function verifiedCleanIndex(root:string,layout:GitLayout):Promise<{files:string[];suspects:string[]}|undefined>{
  if(layout.prefix)return;
  const indexFile=path.join(layout.dir,"index");
  const before=fs.statSync(indexFile,{bigint:true,throwIfNoEntry:false});
  if(!before?.isFile())return;
  const offsets:number[]=[];
  let buffer:Buffer;
  const files=readTrackedIndexPaths(root,layout,(_file,index,offset)=>{
    buffer=index;
    offsets.push(offset);
  });
  if(!files || files.length>5000)return;
  const ns=1_000_000_000n;
  const cutoff=before.mtimeNs;
  const suspects:string[]=[];
  const profile=process.env.GENTLE_GRAPH_PROFILE==="1"?{start:performance.now(),coarse:0,type:0,racy:0,metadata:0,missing:0}:undefined;
  let totalPathChars=0;
  for(let start=0;start<files.length && totalPathChars<=10000;start+=64){
    await Promise.all(files.slice(start,start+64).map(async (file,i)=>{
      const at=offsets[start+i];
      const ctimeNs=buffer.readUInt32BE(at+4),mtimeNs=buffer.readUInt32BE(at+12);
      function verifyWithGit(){
        suspects.push(file);
        totalPathChars+=file.length+12;
      }
      if(!ctimeNs || !mtimeNs){if(profile)profile.coarse++;verifyWithGit();return;}
      const mode=buffer.readUInt32BE(at+24);
      if((mode&0o170000)!==0o100000){if(profile)profile.type++;verifyWithGit();return;}
      const ctime=BigInt(buffer.readUInt32BE(at))*ns+BigInt(ctimeNs);
      const mtime=BigInt(buffer.readUInt32BE(at+8))*ns+BigInt(mtimeNs);
      if(ctime>=cutoff || mtime>=cutoff){if(profile)profile.racy++;verifyWithGit();return;}
      try{
        const stat=await fs.promises.lstat(path.join(root,file),{bigint:true});
        // Git for Windows stores creation time in sd_ctime. Node also exposes
        // the later NTFS change time, which must precede our index snapshot.
        const indexCtime=process.platform==="win32"?stat.birthtimeNs:stat.ctimeNs;
        if(!stat.isFile() || stat.size!==BigInt(buffer.readUInt32BE(at+36))
          || stat.mtimeNs!==mtime || indexCtime!==ctime || stat.ctimeNs>=cutoff
          || process.platform!=="win32" && ((Number(stat.mode)&0o100)!==(mode&0o100)
              || Number(stat.ino & 0xffffffffn)!==buffer.readUInt32BE(at+20))){if(profile)profile.metadata++;verifyWithGit();}
      }catch{if(profile)profile.missing++;verifyWithGit();}
    }));
  }
  const after=fs.statSync(indexFile,{bigint:true,throwIfNoEntry:false});
  if(profile){const {start,...causes}=profile;console.error(JSON.stringify({graphProfile:"index",tracked:files.length,suspects:suspects.length,ms:performance.now()-start,...causes}));}
  return totalPathChars<=10000 && before.mtimeNs===after?.mtimeNs && before.ctimeNs===after?.ctimeNs ? {files,suspects} : undefined;
}

// Git may hash the contents of an entire newly populated directory when entry
// timestamps share the index's second. Compare precise Linux stat data first.
// Any uncertainty falls back to Git, including a concurrent index replacement.
export function verifiedRacyFolders(root:string, layout:GitLayout, files:string[], offsets:number[], bytes:Buffer) {
  if (files.length < 5000 || !offsets.length || layout.prefix) return false;
  const index = path.join(layout.dir,"index");
  const snapshot = fs.statSync(index,{bigint:true,throwIfNoEntry:false});
  if (!snapshot) return false;
  const second = Number(snapshot.mtimeNs / 1000000000n);
  // Group adjacent entries once. Only folders with an actual timestamp tie
  // need exact stats. A sampled cutoff missed small but expensive racy sets.
  const folders=new Set<string>();
  const remaining=new Set<string>();
  const groups:{name:string;start:number;end:number;racy:boolean}[]=[];
  let group:typeof groups[number]|undefined;
  for(let i=0;i<files.length;i++){
    const file=files[i];
    const slash=file.indexOf("/");
    const length=slash<0?file.length:slash;
    if(!group || group.name.length!==length || !file.startsWith(group.name)){
      group={name:file.slice(0,length),start:i,end:i,racy:false};
      groups.push(group);
    }
    group.end=i+1;
    if(bytes.readUInt32BE(offsets[i]+8)>=second)group.racy=true;
  }
  const racyCount=groups.reduce((count,g)=>count+(g.racy?g.end-g.start:0),0);
  if(!racyCount)return false;
  // When most files need precise stats, verify the small remainder in the
  // same pass. Starting diff-files would reread and preload the entire index.
  const verifyAll=racyCount>=files.length*0.75;
  const prefix=root+path.sep;
  for(const {name,start,end,racy} of groups){
    if(!racy && !verifyAll){remaining.add(name);continue;}
    let verified=true;
    for(let i=start;i<end;i++){
      const at = offsets[i];
      const mode = bytes.readUInt32BE(at+24);
      if ((mode & 0o170000) !== 0o100000) {verified=false;break;}
      const cs = bytes.readUInt32BE(at+4), ms = bytes.readUInt32BE(at+12);
      if (!cs || !ms) {verified=false;break;}
      let st;
      try { st = fs.lstatSync(prefix+files[i],{bigint:true,throwIfNoEntry:false}); }
      catch { verified=false;break; }
      if (!st?.isFile() || st.size !== BigInt(bytes.readUInt32BE(at+36)) ||
          st.mtimeNs !== BigInt(bytes.readUInt32BE(at+8))*1000000000n+BigInt(ms) ||
          st.ctimeNs !== BigInt(bytes.readUInt32BE(at))*1000000000n+BigInt(cs) ||
          st.ctimeNs >= snapshot.mtimeNs || st.mtimeNs >= snapshot.mtimeNs ||
          Number(st.ino & 0xffffffffn) !== bytes.readUInt32BE(at+20) ||
          (Number(st.mode)&0o100) !== (mode&0o100)) {verified=false;break;}
    }
    if(verified)folders.add(name);
    else remaining.add(name);
  }
  const after = fs.statSync(index,{bigint:true,throwIfNoEntry:false});
  if(after?.ctimeNs!==snapshot.ctimeNs || after.ino!==snapshot.ino)return false;
  // diff-files concerns tracked entries only. When the smaller side fits,
  // ask Git for the unchecked directories directly (and skip it if empty).
  if(remaining.size<=folders.size){
    const include=[...remaining].map(name=>":(literal)"+name);
    if(include.reduce((n,arg)=>n+arg.length+1,0)<=32000)return include;
  }
  if ([...folders].reduce((sum,f)=>sum+f.length+20,0)>32000)return false;
  return [".",...[...folders].map(name=>":(exclude,literal)"+name)];
}

// Windows Git indexes may store timestamps at whole-second precision. For
// timestamp ties compare working bytes with the indexed blob. A transformed,
// missing, oversized or uncertain file remains a candidate for the graph.
export async function trackedGuideChanges(root:string,layout:GitLayout,source:(file:string)=>boolean){
  const indexPath=path.join(layout.dir,"index");
  const before=fs.statSync(indexPath,{bigint:true,throwIfNoEntry:false});
  if(!before)return;
  const offsets:number[]=[];
  let data:Buffer;
  const files=readTrackedIndexPaths(root,layout,(_file,bytes,offset)=>{data=bytes;offsets.push(offset);});
  if(!files || files.length>5000)return;
  const changed:string[]=[];
  let next=0;
  const second=1000000000n;
  async function scan(){
    while(next<files!.length){
      const i=next++,file=files![i],offset=offsets[i];
      const abs=path.join(root,file);
      try{
        const stat=await fs.promises.lstat(abs,{bigint:true});
        const mtime=BigInt(data.readUInt32BE(offset+8));
        const ns=data.readUInt32BE(offset+12);
        const mode=data.readUInt32BE(offset+24);
        if(stat.isFile() && (mode&0o170000)===0o100000 && stat.size===BigInt(data.readUInt32BE(offset+36))){
          const birth=BigInt(data.readUInt32BE(offset));
          if(stat.birthtimeNs/second===birth && stat.mtimeNs/second===mtime &&
              (!ns || stat.mtimeNs%second===BigInt(ns)) && mtime<before!.mtimeNs/second &&
              stat.ctimeNs<before!.mtimeNs)continue;
          if(source(file) && stat.size<=256n*1024n){
            const bytes=await fs.promises.readFile(abs);
            const digest=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest();
            if(digest.equals(data.subarray(offset+40,offset+60)))continue;
          }
        }
      }catch{/* A missing or concurrently replaced file must be revisited. */}
      changed.push(file);
    }
  }
  await Promise.all(Array.from({length:16},scan));
  const after=fs.statSync(indexPath,{bigint:true,throwIfNoEntry:false});
  if(before.ctimeNs===after?.ctimeNs && before.ino===after.ino)return {files,changed};
}

// A directory listing can prove that there are no untracked entries without
// interpreting ignore rules. Any unfamiliar name delegates that decision to Git.
export async function onlyTrackedEntries(root:string, files:string[]):Promise<boolean>{
  const expected=new Map<string,Set<string>>();
  for(const file of files){
    let child=file;
    while(child){
      const slash=child.lastIndexOf("/");
      const parent=slash<0?"":child.slice(0,slash);
      const name=child.slice(slash+1);
      let names=expected.get(parent);
      if(!names){names=new Set();expected.set(parent,names);}
      if(names.has(name))break;
      names.add(name);
      child=parent;
    }
  }
  const directories=[...expected.keys()];
  for(let start=0;start<directories.length;start+=24){
    const checks=await Promise.all(directories.slice(start,start+24).map(async dir=>{
      try{
        const entries=await fs.promises.readdir(path.join(root,dir),{withFileTypes:true});
        return entries.every(e=>{
          if(!dir && e.name===".git")return true;
          if(!expected.get(dir)!.has(e.name))return false;
          const relative=dir?dir+"/"+e.name:e.name;
          // A directory replacing a tracked file may contain untracked sources.
          return e.isDirectory() === expected.has(relative);
        });
      }catch{return false;}
    }));
    if(checks.includes(false))return false;
  }
  return true;
}
