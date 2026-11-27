import {createRequire} from "node:module";
import fs from "node:fs";
import path from "node:path";
import type {DatabaseSync, StatementSync} from "node:sqlite";
import type {CodeSymbol,FileNode,GraphIndex,SourceSite} from "./types.ts";

const require=createRequire(import.meta.url);
export const SCHEMA_VERSION=2;
const sessions=new Map<string,Store>();
const sleeper=new Int32Array(new SharedArrayBuffer(4));
function retry<T>(work:()=>T):T {
  const delays=[10,25,50,100,200];
  for(let attempt=0;;attempt++){
    try{return work();}
    catch(error){
      const code=(error as {errcode?:number}).errcode & 255;
      if((code!==5 && code!==6) || attempt===delays.length)throw error;
      Atomics.wait(sleeper,0,0,delays[attempt]);
    }
  }
}
class Store {
  statements=new Map<string,StatementSync>();
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;}
  sql(text:string){
    let statement=this.statements.get(text);
    if(!statement){statement=this.db.prepare(text);this.statements.set(text,statement);}
    return statement;
  }
  transaction<T>(work:()=>T){
    return retry(()=>{
      this.db.exec("BEGIN IMMEDIATE");
      try{const result=work();this.db.exec("COMMIT");return result;}
      catch(error){if(this.db.isTransaction)this.db.exec("ROLLBACK");throw error;}
    });
  }
}
const schema=`
CREATE TABLE files(path TEXT PRIMARY KEY,language TEXT,mtime_ms REAL,sha256 TEXT,preview INTEGER,namespace TEXT,has_context INTEGER);
CREATE TABLE symbols(id TEXT PRIMARY KEY,file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  public_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT,line INTEGER,end_line INTEGER,exported INTEGER,signature TEXT,
  reuse_tag TEXT,domain_tag TEXT,boundary_tag TEXT,implementation_name TEXT,flags INTEGER);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);
CREATE TABLE edges(from_file TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,from_symbol TEXT,to_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('import','call','implements','binding')),line INTEGER,role TEXT,qualified TEXT,site_text TEXT);
CREATE INDEX idx_edges_to ON edges(to_name,kind);
CREATE INDEX idx_edges_file ON edges(from_file);
CREATE TABLE symbol_values(symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,kind TEXT,value TEXT);
CREATE INDEX idx_symbol_values ON symbol_values(symbol_id);
CREATE TABLE file_values(file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,kind TEXT,value TEXT);
CREATE INDEX idx_file_values ON file_values(file_path);
CREATE VIRTUAL TABLE files_fts USING fts5(path,domain_tags,symbol_names);
CREATE TRIGGER files_delete_fts BEFORE DELETE ON files BEGIN DELETE FROM files_fts WHERE rowid=old.rowid; END;
CREATE TABLE changes(path TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE INDEX idx_changes_revision ON changes(revision);
CREATE TABLE IF NOT EXISTS metadata(version INTEGER,updatedAt TEXT);`;
const lists=["calls","contracts","localCallees","importCallees","qualifiedCalls"] as const;
const kinds=["call","implements","local_call","import_call","qualified_call"];
function put(s:Store,f:FileNode){
  s.sql("DELETE FROM files WHERE path=?").run(f.path);
  const {lastInsertRowid}=s.sql("INSERT INTO files VALUES(?,?,?,?,?,?,?)").run(f.path,f.language,f.mtimeMs,f.sha256,
    f.preview===undefined?null:Number(f.preview),f.namespace??null,Number(f.dataContexts!==undefined));
  const edge=s.sql("INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)");
  for(const spec of f.imports)edge.run(f.path,null,spec,"import",null,null,null,null);
  for(const [kind,values] of [["export",f.exports],["context",f.dataContexts??[]]] as const)
    for(const v of values)s.sql("INSERT INTO file_values VALUES(?,?,?)").run(f.path,kind,v);
  const tags=new Set<string>();
  for(const [n,sym] of f.symbols.entries()){
    // A source-level ID may be shared by overloads. Keep its storage identity distinct.
    const id=JSON.stringify([f.path,n]);
    const flags=lists.reduce((mask,key,i)=>mask|(sym[key]!==undefined?1<<i:0),sym.sites!==undefined?32:0);
    s.sql("INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,f.path,sym.id,sym.name,sym.kind,sym.line,sym.endLine,
      Number(sym.exported),sym.signature,sym.reuseTag??null,sym.domainTag??null,sym.boundaryTag??null,sym.implementationName??null,flags);
    for(const [i,key] of lists.entries())for(const term of sym[key]??[]){
      if(i<2)edge.run(f.path,id,term,kinds[i],null,null,null,null);
      else s.sql("INSERT INTO symbol_values VALUES(?,?,?)").run(id,key,term);
    }
    for(const site of sym.sites??[])edge.run(f.path,id,site.target,"binding",site.line,site.role,site.qualified??null,site.text??null);
    if(sym.reuseTag)tags.add(sym.reuseTag);
    if(sym.domainTag)tags.add(sym.domainTag);
  }
  s.sql("INSERT INTO files_fts(rowid,path,domain_tags,symbol_names) VALUES(?,?,?,?)").run(lastInsertRowid,f.path,[...tags].join(" "),f.symbols.map(x=>x.name).join(" "));
}
function version(s:Store){return Number(s.sql("PRAGMA user_version").get().user_version);}
function supported(n:number){if(n>SCHEMA_VERSION)throw new Error("Unsupported future Gentle Graph SQLite schema "+n);}
function open(root:string){
  const cached=sessions.get(root);
  if(cached)return cached;
  const {DatabaseSync}=require("node:sqlite") as typeof import("node:sqlite");
  const s=new Store(new DatabaseSync(path.join(root,".gentle-graph","index.sqlite")));
  try{
    s.db.exec("PRAGMA busy_timeout=5000");
    supported(version(s));
    retry(()=>s.db.exec("PRAGMA journal_mode=WAL"));
    s.db.exec("PRAGMA journal_size_limit=67108864; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
    if(version(s)<SCHEMA_VERSION)s.transaction(()=>{
      const current=version(s);supported(current);
      if(current===SCHEMA_VERSION)return;
      const legacy=s.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get();
      if(legacy)s.db.exec("ALTER TABLE files RENAME TO legacy_files");
      s.db.exec(schema);
      if(legacy){
        // Older versions used a JSON snapshot as the authority after a failed SQL save.
        const json=path.join(root,".gentle-graph","index.json");
        const snapshot=fs.existsSync(json)?JSON.parse(fs.readFileSync(json,"utf8")) as GraphIndex:undefined;
        if(snapshot?.version===8 && snapshot.files){
          for(const node of Object.values(snapshot.files))put(s,node);
          s.db.exec("DELETE FROM metadata");s.sql("INSERT INTO metadata VALUES(8,?)").run(snapshot.updatedAt);
        }else for(const row of s.sql("SELECT data FROM legacy_files").iterate())put(s,JSON.parse(String(row.data)));
        s.db.exec("DROP TABLE legacy_files");
      }
      s.db.exec("PRAGMA user_version=2");
    });
    sessions.set(root,s);return s;
  }catch(error){s.db.close();throw error;}
}
export function closeSql(root?:string){
  for(const [key,s] of sessions)if(!root||root===key){s.db.close();sessions.delete(key);}
}
export function sqlVersion(root:string){return Number(open(root).sql("PRAGMA data_version").get().data_version);}
function readFile(s:Store,file:string):FileNode|undefined{
  const r=s.sql("SELECT * FROM files WHERE path=?").get(file);
  if(!r)return;
  const f:FileNode={path:file,language:String(r.language),mtimeMs:Number(r.mtime_ms),sha256:String(r.sha256),imports:[],exports:[],symbols:[]};
  if(r.preview!==null)f.preview=!!r.preview;
  if(r.namespace!==null)f.namespace=String(r.namespace);
  if(r.has_context)f.dataContexts=[];
  const symbols=new Map<string,CodeSymbol>();
  for(const row of s.sql("SELECT * FROM symbols WHERE file_path=? ORDER BY rowid").iterate(file)){
    const sym:CodeSymbol={id:String(row.public_id),name:String(row.name),kind:row.kind as CodeSymbol["kind"],file,
      line:Number(row.line),endLine:Number(row.end_line),exported:!!row.exported,signature:String(row.signature),calls:[]};
    for(const [key,column] of [["reuseTag","reuse_tag"],["domainTag","domain_tag"],["boundaryTag","boundary_tag"],["implementationName","implementation_name"]] as const)
      if(row[column]!==null)sym[key]=String(row[column]);
    lists.forEach((key,i)=>{if(Number(row.flags)&(1<<i))sym[key]=[];});
    if(Number(row.flags)&32)sym.sites=[];
    symbols.set(String(row.id),sym);f.symbols.push(sym);
  }
  for(const e of s.sql("SELECT * FROM edges WHERE from_file=? ORDER BY rowid").iterate(file)){
    const term=String(e.to_name);
    if(e.kind==="import"){f.imports.push(term);continue;}
    const sym=symbols.get(String(e.from_symbol))!;
    if(e.kind==="binding"){
      const site:SourceSite={target:term,role:e.role as SourceSite["role"],line:Number(e.line)};
      if(e.qualified!==null)site.qualified=String(e.qualified);
      if(e.site_text!==null)site.text=String(e.site_text);
      sym.sites.push(site);
    }else sym[lists[kinds.indexOf(String(e.kind))]].push(term);
  }
  for(const v of s.sql("SELECT v.* FROM symbols s JOIN symbol_values v ON v.symbol_id=s.id WHERE s.file_path=? ORDER BY v.rowid").iterate(file))
    symbols.get(String(v.symbol_id))[v.kind as "localCallees"|"importCallees"|"qualifiedCalls"].push(String(v.value));
  for(const v of s.sql("SELECT kind,value FROM file_values WHERE file_path=? ORDER BY rowid").iterate(file))
    (v.kind==="export"?f.exports:f.dataContexts).push(String(v.value));
  return f;
}
const revisions=new WeakMap<GraphIndex,number>();
const timestamps=new WeakMap<GraphIndex,Map<string,number>>();
export function storedMtime(index:GraphIndex,file:string){return timestamps.get(index)?.get(file);}
function lazyFile(s:Store,index:GraphIndex,file:string,mtime:number){
  const files=index.files;
  timestamps.get(index).set(file,mtime);
  const assign=(value:FileNode)=>Object.defineProperty(files,file,{value,enumerable:true,configurable:true,writable:true});
  Object.defineProperty(files,file,{enumerable:true,configurable:true,set:assign,get(){
    const nested=s.db.isTransaction;
    if(!nested)s.db.exec("BEGIN");
    try{const value=readFile(s,file);if(!nested)s.db.exec("COMMIT");if(value)assign(value);else delete files[file];return value;}
    catch(error){if(!nested)s.db.exec("ROLLBACK");throw error;}
  }});
}
function revision(s:Store){return Number(s.sql("SELECT coalesce(max(revision),0) AS rev FROM changes").get().rev);}
export function readSqlIndex(root:string):GraphIndex{
  const s=open(root);
  const index:GraphIndex={version:8,projectRoot:root,updatedAt:"",files:Object.create(null)};
  timestamps.set(index,new Map());
  s.db.exec("BEGIN");
  try{
    for(const row of s.sql("SELECT path,mtime_ms FROM files ORDER BY rowid").iterate())
      lazyFile(s,index,String(row.path),Number(row.mtime_ms));
    revisions.set(index,revision(s));
    index.updatedAt=String(s.sql("SELECT updatedAt FROM metadata").get()?.updatedAt??new Date(0).toISOString());
    s.db.exec("COMMIT");return index;
  }catch(error){s.db.exec("ROLLBACK");throw error;}
}
export function refreshSqlIndex(root:string,index:GraphIndex){
  const prior=revisions.get(index);
  if(prior===undefined)return;
  const s=open(root),changed:string[]=[];
  s.db.exec("BEGIN");
  try{
    supported(version(s));
    for(const row of s.sql("SELECT c.path,f.mtime_ms FROM changes c LEFT JOIN files f ON f.path=c.path WHERE c.revision>? ORDER BY c.revision,c.rowid").iterate(prior)){
      const file=String(row.path);changed.push(file);
      if(row.mtime_ms===null){delete index.files[file];timestamps.get(index).delete(file);}
      else lazyFile(s,index,file,Number(row.mtime_ms));
    }
    revisions.set(index,revision(s));
    index.updatedAt=String(s.sql("SELECT updatedAt FROM metadata").get()?.updatedAt??index.updatedAt);
    s.db.exec("COMMIT");return changed;
  }catch(error){s.db.exec("ROLLBACK");throw error;}
}
export function writeSqlIndex(root:string,index:GraphIndex,changed:Set<string>,promote:boolean){
  const s=open(root);
  s.transaction(()=>{
    supported(version(s));
    const first=promote && !s.sql("SELECT version FROM metadata LIMIT 1").get();
    const next=revision(s)+1;
    for(const file of first?Object.keys(index.files):changed){
      const node=index.files[file];
      s.sql("INSERT INTO changes VALUES(?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision").run(file,next);
      if(node)timestamps.get(index)?.set(file,node.mtimeMs);else timestamps.get(index)?.delete(file);
      if(node)put(s,node);else s.sql("DELETE FROM files WHERE path=?").run(file);
    }
    s.db.exec("DELETE FROM metadata");
    s.sql("INSERT INTO metadata VALUES(8,?)").run(index.updatedAt);
  });
}
export function searchSqlFiles(root:string,intent:string,limit=15):string[]{
  const words=intent.match(/[\p{L}\p{N}_]+/gu);
  if(!words?.length)return [];
  const match=words.map(w=>'"'+w+'"*').join(" OR ");
  return open(root).sql("SELECT path FROM files_fts WHERE files_fts MATCH ? ORDER BY bm25(files_fts,5.0,3.0,1.0) LIMIT ?")
    .all(match,limit).map(r=>String(r.path));
}

// Keep guide ranking bounded while retaining cross-module evidence.
export function sqlCallerFiles(root:string,name:string):string[]{
  return open(root).sql("SELECT DISTINCT from_file FROM edges WHERE to_name=? AND kind='call' LIMIT 16").all(name).map(r=>String(r.from_file));
}
export function sqlArchitectureSignals(root:string):string[]{
  const sql=`
    SELECT 'SwiftUI' AS tag WHERE EXISTS(SELECT 1 FROM edges e JOIN files f ON f.path=e.from_file WHERE e.kind='import' AND e.to_name='SwiftUI' AND f.language='swift')
    UNION ALL SELECT 'Spring Boot' WHERE EXISTS(SELECT 1 FROM symbols s JOIN files f ON f.path=s.file_path WHERE f.language='java' AND s.domain_tag IN ('RestController','Service','Repository'))
    UNION ALL SELECT 'MVVM' WHERE EXISTS(SELECT 1 FROM file_values v JOIN files f ON f.path=v.file_path WHERE f.language='csharp' AND v.kind='context' AND (v.value GLOB '*VM' OR v.value GLOB '*ViewModel'))
    UNION ALL SELECT 'DI' WHERE EXISTS(SELECT 1 FROM symbols s JOIN files f ON f.path=s.file_path WHERE f.language='csharp' AND (s.name GLOB 'AddScoped<*' OR s.name GLOB 'AddSingleton<*' OR s.name GLOB 'AddTransient<*'))
    UNION ALL SELECT 'CQRS' WHERE EXISTS(SELECT 1 FROM edges e JOIN files f ON f.path=e.from_file WHERE f.language='csharp' AND e.kind='implements' AND e.to_name IN ('IRequestHandler','INotificationHandler'))`;
  return open(root).sql(sql).all().map(r=>String(r.tag));
}
export function uniqueSqlSymbol(root:string,name:string){
  return open(root).sql("SELECT 1 FROM symbols WHERE name=? LIMIT 2").all(name).length===1;
}
