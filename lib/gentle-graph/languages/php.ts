import { nominal, baseNames } from "./nominal.ts";
import type { SymbolKind } from "../types.ts";
export const php = nominal({
  id:"php",extensions:[".php"],test:/Test\.php$|(?:^|\/)tests\//i,
  namespace:s=>s.match(/^namespace\s+([\w\\]+)/)?.[1],
  imports:s=>s.match(/^use\s+([\w\\]+)/)?.[1],
  declaration(s){
    const m=s.match(/\b(class|interface|trait|enum)\s+(\w+)(.*)/);
    if(m) return {kind:m[1] as SymbolKind,name:m[2],contracts:baseNames(m[3].split(/\b(?:extends|implements)\s+/).slice(1).join(","))};
  },
  method:s=>s.match(/\bfunction\s+&?\s*(\w+)\s*\(/)?.[1]
});
