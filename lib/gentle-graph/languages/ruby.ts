import path from "node:path";
import { sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";
import type { CodeSymbol } from "../types.ts";
export const ruby:LanguageAdapter={
  id:"ruby",extensions:[".rb"],isTestFile:f=>/_(?:spec|test)\.rb$/.test(f),
  resolveRelativeImport(file,spec,paths){
    const base=path.posix.join(path.posix.dirname(file),spec);
    return [base,base+".rb"].find(p=>paths.has(p))??null;
  },
  parse(_root,file,content){
    const {clean,lines,result,add}=sourceFile(file,content,"ruby");
    const stack:{type?:CodeSymbol; line:number; method?:string; owner?:string}[]=[];
    clean.forEach((line,i)=>{
      const imp=line.match(/^\s*require(_relative)?\b/);
      if(imp){ const spec=lines[i].match(/\brequire(?:_relative)?\s*\(?\s*["']([^"']+)/)?.[1]; if(spec) result.imports.push(imp[1]?"./"+spec:spec); }
      const decl=line.match(/^\s*(module|class)\s+([\w:]+)(?:\s*<\s*([\w:]+))?/);
      const owner=stack.findLast(frame=>frame.type)?.type;
      const method=line.match(/^\s*def\s+(?:self\.)?(\w+[!?=]?)/);
      const mix=line.match(/^\s*(?:include|extend)\s+([\w:, ]+)/);
      if(decl){
        const sym=add(decl[2],decl[1]==="module"?"trait":"class",i,i,true,[]);
        if(decl[3]) sym.contracts=[decl[3].split("::").at(-1)!];
        stack.push({type:sym,line:i});
      } else if(method) stack.push({method:method[1],owner:owner?.name,line:i});
      else if(mix && owner) (owner.contracts??=[]).push(...mix[1].split(",").map(s=>s.trim().split("::").at(-1)!));
      else if(/^\s*(?:if|unless|case|begin|for|while|until)\b|\bdo\s*(?:\|.*\|)?\s*$/.test(line)) stack.push({line:i});
      else if(/^\s*end\b/.test(line)){
        const frame=stack.pop();
        if(frame?.type) frame.type.endLine=i+1;
        if(frame?.method) add(frame.owner?frame.owner+"."+frame.method:frame.method,frame.owner?"method":"function",frame.line,i,true);
      }
    });
    return result;
  }
};
