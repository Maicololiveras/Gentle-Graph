import path from "node:path";
import { nominal, baseNames } from "./nominal.ts";
const parser=nominal({
  id:"cpp",extensions:[".c",".h",".cpp",".hpp",".cc"],test:/_test\.(?:c|cpp|cc)$/i,
  namespace:s=>s.match(/^namespace\s+([\w:]+)/)?.[1],
  imports:(s,original)=>/^#\s*include\b/.test(s)?original.match(/#\s*include\s*"([^"]+)"/)?.[1]:undefined,
  declaration(s){
    const m=s.match(/^(?:template\s*<[^>]+>\s*)?(class|struct)\s+(\w+)(?:\s+final)?(?:\s*:\s*([^;]+))?/);
    if(m && !s.trimEnd().endsWith(";")) return {name:m[2],kind:m[1] as "class"|"struct",contracts:baseNames(m[3]??"")};
  },
  method:s=>s.match(/^(?:[\w:<>,*&]+\s+)+([\w:]+)\s*\(/)?.[1]
});
export const cpp={...parser,resolveRelativeImport(file:string,spec:string,files:Set<string>){
  const local=path.posix.join(path.posix.dirname(file),spec);
  return files.has(local)?local:files.has(spec)?spec:null;
}};
