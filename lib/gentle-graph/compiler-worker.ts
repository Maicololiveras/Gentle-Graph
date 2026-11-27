// The compiler can initialize while the query worker loads its graph modules.
// This worker only handles source text already admitted by the normal indexer.
import {workerData,type MessagePort} from "node:worker_threads";
import {typescript,workspaceCompiler} from "./languages/typescript.ts";

const {port,root,signal,profile} = workerData as {port:MessagePort;root:string;signal:Int32Array;profile:boolean};
const start = profile ? performance.now() : 0;
workspaceCompiler(root);
if (profile) console.error(JSON.stringify({graphProfile:"compiler",start,end:performance.now()}));
port.on("message", ({file,content}) => {
  try {
    const begin = profile ? performance.now() : 0;
    const parsed = typescript.parse(root,file,content);
    if (profile) console.error(JSON.stringify({graphProfile:"compilerParse",file,start:begin,end:performance.now()}));
    port.postMessage({parsed});
  }
  catch (error) { port.postMessage({error:String(error)}); }
  finally { Atomics.add(signal,0,1); Atomics.notify(signal,0); }
});
