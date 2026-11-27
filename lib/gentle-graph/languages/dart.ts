import path from "node:path";
import {nominal,baseNames} from "./nominal.ts";
const parser=nominal({
  id:"dart",extensions:[".dart"],test:/_test\.dart$/,
  imports:(s,original)=>/^import\b/.test(s)?original.match(/\bimport\s+["']([^"']+)/)?.[1]:undefined,
  declaration(s){
    const m=s.match(/\b(class|mixin|extension)\s+(\w+)(.*)/);
    if(m) return {name:m[2],kind:m[1]==="mixin"?"trait":"class",
      contracts:baseNames(m[3].split(/\b(?:extends|implements|with)\s+/).slice(1).join(","))};
  },
  method:s=>s.match(/^(?:[\w<>?,]+\s+)+(\w+)\s*\(/)?.[1]
});
export const dart={...parser,resolveRelativeImport(file:string,spec:string,paths:Set<string>){
  const local=path.posix.join(path.posix.dirname(file),spec);
  return paths.has(local)?local:null;
}};
