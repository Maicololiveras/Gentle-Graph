import fs from "node:fs";
import path from "node:path";
import {parentPort} from "node:worker_threads";
import {withFileLock} from "./store.ts";
import type {GraphTelemetryEvent} from "./telemetry.ts";

parentPort.on("message", ({event,trace}:{event:GraphTelemetryEvent; trace?:string}) => {
  try {
    // Preserve the existing benchmark trace even when the worktree is read-only.
    if (trace) fs.appendFileSync(trace,JSON.stringify({id:event.callId,tool:event.tool,engineMs:event.engineMs})+"\n");
  } catch { /* Best effort. */ }
  try {
    const dir = path.join(event.worktreeRoot,".gentle-graph");
    fs.mkdirSync(dir,{recursive:true});
    const file = path.join(dir,"telemetry.jsonl");
    const line = JSON.stringify(event)+"\n";
    withFileLock(path.join(dir,"telemetry.lock"),() => {
      const size = fs.statSync(file,{throwIfNoEntry:false})?.size ?? 0;
      if (size && size + Buffer.byteLength(line) > 5 * 1024 * 1024) {
        fs.renameSync(file,path.join(dir,"telemetry.prev.jsonl"));
      }
      fs.appendFileSync(file,line,{mode:0o600});
    });
  } catch { /* Optional diagnostics must not fail a tool. */ }
  parentPort.postMessage(true);
});
