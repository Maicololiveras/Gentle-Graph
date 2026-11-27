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
