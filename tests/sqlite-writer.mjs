import {clearMemoryCache,loadGraphIndex,saveGraphIndex,updateArchGuide} from "../lib/gentle-graph/store.ts";
const [root,id]=process.argv.slice(2);
const index=loadGraphIndex(root),file=id+".ts";
process.once("message",()=>{
  index.files[file]={path:file,language:"typescript",mtimeMs:1,sha256:id,imports:[],exports:[],symbols:[]};
  saveGraphIndex(root,index,new Set([file]));
  updateArchGuide(root,guide=>guide.patterns.push({id,entry:file,domain:id,files:[file],guidance:id,updatedAt:"test"}));
  clearMemoryCache(root);
  process.disconnect();
});
process.send("ready");
