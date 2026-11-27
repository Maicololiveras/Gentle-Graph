import { findBraceBlockEnd, sourceFile } from "./lexer-core.ts";
import type { SymbolKind } from "../types.ts";
import type { LanguageAdapter } from "./types.ts";

// The language supplies declaration grammar. Block ownership and line evidence are shared.
export interface Declaration { name: string; kind: SymbolKind; contracts?: string[]; implementationName?: string }
interface Grammar {
  id: string; extensions: string[]; test: RegExp;
  declaration(line: string): Declaration | undefined;
  method(line: string): string | undefined;
  imports?(line: string, original: string): string | undefined;
  namespace?(line: string): string | undefined;
}
export function baseNames(clause: string) {
  return clause.replace(/<[^<>]*>/g,"").split(/,|\b(?:extends|implements|with)\b/).flatMap(part=>{
    const match=part.trim().replace(/^(?:(?:public|private|protected|virtual)\s+)+/,"").match(/^(?:[\\\w.:]+[\\.:])?([A-Za-z_]\w*)/);
    return match ? [match[1]] : [];
  });
}
export function nominal(g: Grammar): LanguageAdapter {
  return { id:g.id, extensions:g.extensions, isTestFile:file=>g.test.test(file),
    parse(_root,file,content) {
      const {clean,lines,result,add}=sourceFile(file,content,g.id);
      const owners: {name:string;end:number}[]=[];
      let methodEnd=-1;
      for (let i=0;i<clean.length;i++) {
        const line=clean[i].trim();
        while(owners.length && owners.at(-1)!.end<i) owners.pop();
        if(!line || i<=methodEnd) continue;
        const ns=g.namespace?.(line);
        if(ns) result.namespace=ns;
        const spec=g.imports?.(line,lines[i]);
        if(spec) result.imports.push(spec);
        // Join a split type header up to its opening brace or declaration terminator.
        let header=line;
        if (!/[{;]/.test(line) && /\b(class|interface|record|struct|protocol|actor|extension|enum|object|mixin)\s+\w+/.test(line)) {
          for(let j=i+1;j<Math.min(clean.length,i+12) && !/[{;]/.test(header);j++) header+=" "+clean[j].trim();
        }
        const decl=g.declaration(header.split("{")[0]);
        if(decl) {
          const end=findBraceBlockEnd(clean,i,clean.length);
          const sym=add(decl.name,decl.kind,i,end,true,[]);
          if(decl.contracts?.length) sym.contracts=decl.contracts;
          if(decl.implementationName) sym.implementationName=decl.implementationName;
          owners.push({name:decl.implementationName??decl.name,end});
          continue;
        }
        const name=g.method(line);
        if(name && !/^(?:if|for|while|switch|catch|return|new|throw)\b/.test(line)) {
          methodEnd=findBraceBlockEnd(clean,i,clean.length);
          const owner=owners.at(-1)?.name;
          add(owner ? owner+"."+name : name,owner?"method":"function",i,methodEnd,true);
        }
      }
      return result;
    }
  };
}
