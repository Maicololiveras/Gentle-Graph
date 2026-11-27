// Only preloaded by profile-cold-guide.mjs, in a separate diagnostic process.
import {registerHooks} from "node:module";
import {threadId} from "node:worker_threads";
const log=(name,start)=>process._rawDebug("GUIDE_SPAN "+JSON.stringify({name,start,end:performance.now(),threadId}));
globalThis.guideTrace=(name,fn)=>{
  const start=performance.now();
  try{return fn();}finally{log(name,start);}
};
globalThis.guideSpan=log;
registerHooks({load(url,context,next){
  const start=performance.now();
  const result=next(url,context);
  if(!url.includes("/lib/gentle-graph/") || !url.endsWith(".ts") || !result.source)return result;
  let source=String(result.source);
  if(url.endsWith("/store-sqlite.ts")){
    // Includes source loading, linking dependencies and evaluation in this isolate.
    source+='\nglobalThis.guideSpan("storeModule",'+start+');\n';
    source=source.replace('new DatabaseSync(path.join(root,".gentle-graph","index.sqlite"))',
      'globalThis.guideTrace("databaseOpen",()=>new DatabaseSync(path.join(root,".gentle-graph","index.sqlite")))');
    source=source.replace('if(version(s)<SCHEMA_VERSION)s.transaction','const migrateStart=performance.now();const migrating=version(s)<SCHEMA_VERSION;if(migrating)s.transaction')
      .replace('sessions.set(root,s);','if(migrating)globalThis.guideSpan("migration",migrateStart);sessions.set(root,s);');
  }
  if(url.endsWith("/store.ts") || url.endsWith("/store-sqlite.ts")){
    source=source.replaceAll('require("node:sqlite")','globalThis.guideTrace("nativeModule",()=>require("node:sqlite"))');
    source=source.replace('fs.openSync(file,"wx")','path.basename(file)==="guide.lock"?globalThis.guideTrace("guideLockAcquire",()=>fs.openSync(file,"wx")):fs.openSync(file,"wx")');
    source=source.replace(/(function (?:persistIndex|saveGraphIndex)\([^\n]*\)\s*(?::\s*void\s*)?\{)/g,(line)=>{
      if(line.includes("saveGraphIndex") && source.includes("function persistIndex("))return line;
      return line+'const traceSaveStart=performance.now();try{';
    });
    const target=source.includes("function persistIndex(")?"function persistIndex(":"function saveGraphIndex(";
    const begin=source.indexOf(target);
    if(begin>=0){
      const end=source.indexOf("\n}",begin);
      source=source.slice(0,end)+'\n}finally{globalThis.guideSpan("saveIndex",traceSaveStart);}'+source.slice(end);
    }
  }
  if(url.endsWith("/indexer.ts"))source=source.replace('parseSourceFile(root, file, content, preview)','globalThis.guideTrace("parse",()=>parseSourceFile(root, file, content, preview))');
  return {...result,source};
}});
