import {nominal,baseNames} from "./nominal.ts";
export const swift=nominal({
  id:"swift",extensions:[".swift"],test:/Tests\.swift$/,
  imports:s=>s.match(/^(?:@testable\s+)?import\s+([\w.]+)/)?.[1],
  declaration(s){
    const m=s.match(/\b(protocol|struct|class|actor|extension)\s+(\w+)(?:<[^>]*>)?\s*(?::\s*(.*))?$/);
    if(!m) return;
    const extension=m[1]==="extension";
    return {name:extension?"extension "+m[2]:m[2],kind:m[1]==="protocol"?"interface":m[1]==="struct"?"struct":"class",
      implementationName:extension?m[2]:undefined,contracts:baseNames((m[3]??"").split(/\bwhere\b/)[0])};
  },
  method:s=>s.match(/\bfunc\s+(\w+)\s*(?:<[^>]*>)?\(/)?.[1]
});
