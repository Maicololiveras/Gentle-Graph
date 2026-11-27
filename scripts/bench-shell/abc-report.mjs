import fs from "node:fs";
import path from "node:path";

const fields=["tokens","input","cacheRead","cacheWrite","output","costUSD","elapsedMs","firstEditMs","turns","patchBytes"];
const table=(headers,rows)=>[headers,headers.map(()=>"---"),...rows].map(row=>"| "+row.map(v=>v??"N/D").join(" | ")+" |").join("\n");

export function reportABC(manifest){
  const {out,rows}=manifest;
  const valid=manifest.orders.map((_,i)=>i+1).filter(round=>{
    const group=rows.filter(row=>row.round===round);
    return group.length===3 && group.every(row=>row.valid);
  });
  const totals={};
  for(const key of ["tokens","costUSD","elapsedMs","firstEditMs"]){
    const item={};
    for(const arm of ["A","B","C"]){
      const values=rows.filter(row=>valid.includes(row.round) && row.arm===arm).map(row=>row[key]);
      const sum=values.length && values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null;
      item[arm]={sum,average:sum===null?null:sum/values.length};
    }
    for(const other of ["A","B"])item["Cvs"+other]=item[other].sum>0 && item.C.sum!==null?100*(item[other].sum-item.C.sum)/item[other].sum:null;
    totals[key]=item;
  }
  Object.assign(manifest,{validRounds:valid,consolidated:totals});
  const lines=["# Benchmark A/B/C","",out,"",manifest.error??("Rondas válidas: "+(valid.join(", ")||"ninguna"))];
  for(const [i,order] of manifest.orders.entries()){
    const group=rows.filter(row=>row.round===i+1);
    lines.push("","## Ronda "+(i+1)+" · "+order,"",table(["Brazo","Tests","TS",...fields],group.map(row=>[row.arm,row.tests,row.typecheck,...fields.map(k=>row[k])])),"");
    const tools=[...new Set(["read","bash","edit","codemode",...group.flatMap(row=>Object.keys(row.tools))])].sort();
    lines.push(table(["Herramienta",...group.map(r=>r.arm)],[
      ...tools.map(t=>[t,...group.map(r=>String(r.tools[t]??0)+" ("+(r.nested[t]??0)+" anidadas)")]),
      ["Búsquedas",...group.map(r=>r.searches)],["Uso del grafo",...group.map(r=>r.graphUsed?"sí":"no")]
    ]));
  }
  lines.push("","## Consolidado","","Tiempos en milisegundos. Un importe o una primera edición sin medición se conserva como N/D.","",
    table(["Métrica","Σ A","Media A","Σ B","Media B","Σ C","Media C","Ahorro C/A %","Ahorro C/B %"],
      Object.entries(totals).map(([key,v])=>[key,...["A","B","C"].flatMap(arm=>[v[arm].sum,v[arm].average]),v.CvsA,v.CvsB])));
  lines.push("","## Evidencia","",...rows.map(row=>"- "+row.folder+" (sessions/, calls.jsonl, verification-tests.txt, verification-tsc.txt, changes.patch, results.json)"));
  fs.writeFileSync(path.join(out,"informe-abc.md"),lines.join("\n")+"\n");
  fs.writeFileSync(path.join(out,"summary.json"),JSON.stringify(manifest,null,2));
}
