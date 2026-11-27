import path from "node:path";
import { typescript } from "./typescript.ts";
import { sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";
export const svelte:LanguageAdapter={
  id:"svelte",extensions:[".svelte"],isTestFile:f=>/\.(?:spec|test)\.svelte$/.test(f),
  resolveRelativeImport:typescript.resolveRelativeImport,
  parse(root,file,content){
    const {result,add}=sourceFile(file,content,"svelte");
    const template=content.replace(/<!--[\s\S]*?-->/g,m=>m.replace(/[^\n]/g," ")).replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi,(match,script,offset)=>{
      const start=offset+match.indexOf(">")+1;
      const padding="\n".repeat(content.slice(0,start).split("\n").length-1);
      const parsed=typescript.parse(root,file+".ts",padding+script);
      result.imports.push(...parsed.imports);
      result.exports.push(...parsed.exports);
      for(const symbol of parsed.symbols) result.symbols.push({...symbol,file,id:file+"#"+symbol.name});
      return match.replace(/[^\n]/g," ");
    }).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"");
    const calls=[...new Set([...template.matchAll(/<([A-Z]\w*(?:\.\w+)*)\b/g)].map(m=>m[1]))];
    add(path.posix.basename(file,".svelte"),"class",0,content.split("\n").length-1,true,calls);
    return result;
  }
};
