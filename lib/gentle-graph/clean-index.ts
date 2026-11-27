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
  let totalPathChars=0;
  for(let start=0;start<files.length && totalPathChars<=10000;start+=64){
    await Promise.all(files.slice(start,start+64).map(async (file,i)=>{
      const at=offsets[start+i];
      const ctimeNs=buffer.readUInt32BE(at+4),mtimeNs=buffer.readUInt32BE(at+12);
      function verifyWithGit(){
        suspects.push(file);
        totalPathChars+=file.length+12;
      }
      if(!ctimeNs || !mtimeNs){verifyWithGit();return;}
      const mode=buffer.readUInt32BE(at+24);
      if((mode&0o170000)!==0o100000){verifyWithGit();return;}
      const ctime=BigInt(buffer.readUInt32BE(at))*ns+BigInt(ctimeNs);
      const mtime=BigInt(buffer.readUInt32BE(at+8))*ns+BigInt(mtimeNs);
      if(ctime>=cutoff || mtime>=cutoff){verifyWithGit();return;}
      try{
        const stat=await fs.promises.lstat(path.join(root,file),{bigint:true});
        if(!stat.isFile() || stat.size!==BigInt(buffer.readUInt32BE(at+36))
          || stat.mtimeNs!==mtime || stat.ctimeNs!==ctime
          || process.platform!=="win32" && ((Number(stat.mode)&0o100)!==(mode&0o100)
              || Number(stat.ino & 0xffffffffn)!==buffer.readUInt32BE(at+20)))verifyWithGit();
      }catch{verifyWithGit();}
    }));
  }
  const after=fs.statSync(indexFile,{bigint:true,throwIfNoEntry:false});
  return totalPathChars<=10000 && before.mtimeNs===after?.mtimeNs && before.ctimeNs===after?.ctimeNs ? {files,suspects} : undefined;
}
