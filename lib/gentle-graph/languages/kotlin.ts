import { nominal, baseNames } from "./nominal.ts";
export const kotlin=nominal({
  id:"kotlin",extensions:[".kt",".kts"],test:/Test\.kt$/,
  namespace:s=>s.match(/^package\s+([\w.]+)/)?.[1],
  imports:s=>s.match(/^import\s+([\w.*]+)/)?.[1],
  declaration(s){
    const m=s.match(/\b(class|object|interface)\s+(\w+)(.*)/);
    if(m) {
      const tail=m[3].replace(/\([^()]*\)/g,"");
      const clause=tail.match(/^\s*(?:<[^>]*>\s*)?:\s*(.*)/);
      return {name:m[2],kind:m[1]==="interface"?"interface":"class",contracts:baseNames(clause?.[1]??"")};
    }
  },
  method:s=>s.match(/\bfun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\(/)?.[1]
});
