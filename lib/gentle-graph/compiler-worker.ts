// The compiler is loaded when the query worker sends its first full TS parse.
// This worker only handles source text already admitted by the normal indexer.
import {workerData,type MessagePort} from "node:worker_threads";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
let adapter: typeof import("./languages/typescript.ts").typescript;

const {port,root,signal,profile} = workerData as {port:MessagePort;root:string;signal:Int32Array;profile:boolean};
port.on("message", ({file,content}) => {
  try {
    const begin = profile ? performance.now() : 0;
    adapter ??= require("./languages/typescript.ts").typescript;
    const parsed = adapter.parse(root,file,content);
    if (profile) console.error(JSON.stringify({graphProfile:"compilerParse",file,start:begin,end:performance.now()}));
    port.postMessage({parsed});
  }
  catch (error) { port.postMessage({error:String(error)}); }
  finally { Atomics.add(signal,0,1); Atomics.notify(signal,0); }
});
