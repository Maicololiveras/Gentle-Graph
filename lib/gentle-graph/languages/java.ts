import { nominal, baseNames } from "./nominal.ts";
import type { SymbolKind } from "../types.ts";
const parser = nominal({
  id:"java", extensions:[".java"], test:/(?:^|\/)src\/test\/|(?:Tests?|IT)\.java$/i,
  namespace:s=>s.match(/^package\s+([\w.]+)/)?.[1],
  imports:s=>s.match(/^import\s+(?:static\s+)?([\w.*]+)/)?.[1],
  declaration(s) {
    const m=s.match(/\b(class|interface|record|enum)\s+(\w+)(.*)/);
    if(m) return {kind:m[1] as SymbolKind,name:m[2],contracts:baseNames(m[3].split(/\b(?:extends|implements)\s+/).slice(1).join(","))};
  },
  method:s=>s.match(/^(?:(?:public|private|protected|final|static|abstract|synchronized|default)\s+)*(?:[\w.$<>?,\[\] ]+\s+)(\w+)\s*\(/)?.[1]
});

export const java = { ...parser, parse(root:string,file:string,content:string) {
  const parsed=parser.parse(root,file,content);
  for (const symbol of parsed.symbols.filter(s=>s.kind==="class")) {
    const annotation=content.split(/\r?\n/).slice(Math.max(0,symbol.line-5),symbol.line).join("\n").match(/^\s*@(RestController|Service|Repository)\b/m);
    if (annotation) symbol.domainTag ??= annotation[1];
  }
  return parsed;
}};
