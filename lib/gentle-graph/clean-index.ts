// A freshly populated worktree can make Git compare thousands of blobs that
// share the index's second. Certify only entries with precise kernel timestamps
// predating the index. Git handles ties, coarse timestamps and other formats.
import fs from "node:fs";
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
  if(!groups.some(entry=>entry.racy))return false;
  const prefix=root+path.sep;
  for(const {name,start,end,racy} of groups){
    if(!racy){remaining.add(name);continue;}
    folders.add(name);
    for(let i=start;i<end;i++){
      const at = offsets[i];
      const mode = bytes.readUInt32BE(at+24);
      if ((mode & 0o170000) !== 0o100000) return false;
      const cs = bytes.readUInt32BE(at+4), ms = bytes.readUInt32BE(at+12);
      if (!cs || !ms) return false;
      let st;
      try { st = fs.lstatSync(prefix+files[i],{bigint:true,throwIfNoEntry:false}); }
      catch { return false; }
      if (!st?.isFile() || st.size !== BigInt(bytes.readUInt32BE(at+36)) ||
          st.mtimeNs !== BigInt(bytes.readUInt32BE(at+8))*1000000000n+BigInt(ms) ||
          st.ctimeNs !== BigInt(bytes.readUInt32BE(at))*1000000000n+BigInt(cs) ||
          st.ctimeNs >= snapshot.mtimeNs || st.mtimeNs >= snapshot.mtimeNs ||
          Number(st.ino & 0xffffffffn) !== bytes.readUInt32BE(at+20) ||
          (Number(st.mode)&0o100) !== (mode&0o100)) return false;
    }
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
