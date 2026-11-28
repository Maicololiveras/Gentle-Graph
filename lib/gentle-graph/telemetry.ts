import {setImmediate as nextTurn} from "node:timers/promises";
import path from "node:path";
import {Worker} from "node:worker_threads";
import type {QueryReply} from "./query-session.ts";

export type GraphTool = "graph_guide" | "graph_inspect" | "graph_impact" | "graph_register_pattern";
export interface GraphTelemetryEvent {
  ts: string;
  sessionId: string | null;
  callId: string;
  actorRole: string;
  isChild: boolean;
  worktreeRoot: string;
  tool: GraphTool;
  viaCodemode: boolean | null;
  bootMs: number | null;
  workMs: number | null;
  engineMs: number;
  cacheHit: boolean | null;
  mode: string;
  indexed: number | null;
  charsOut: number;
  partial: boolean | null;
  scope: string | null;
  error: string | null;
}

export function queryEvent(tool:GraphTool, callId:string, root:string, sessionId:string | undefined,
  viaCodemode:boolean | null, elapsed:number, reply?:QueryReply, error:string | null = null):GraphTelemetryEvent {
  const isChild = process.env.GENTLE_PI_AGENTS_CHILD === "1";
  return {
    ts:new Date().toISOString(), sessionId:sessionId ?? null, callId, actorRole:isChild
      ? process.env.GENTLE_GRAPH_ACTOR_ROLE || "unknown" : "orchestrator",
    isChild, worktreeRoot:path.resolve(root), tool, viaCodemode, bootMs:reply?.bootMs ?? null,
    workMs:reply?.workMs ?? null, engineMs:reply?.engineMs ?? elapsed, cacheHit:reply?.cacheHit ?? null,
    mode:reply?.mode ?? "unknown", indexed:reply?.indexed ?? null, charsOut:reply?.text.length ?? 0,
    partial:reply?.partial ?? null, scope:null, error
  };
}

// Disk I/O, rotation and cross-process contention stay off the tool's thread.
export function telemetryWriter() {
  let worker: Worker | undefined;
  let tail = Promise.resolve();
  function write(event:GraphTelemetryEvent, trace?:string) {
    return new Promise<void>(resolve => {
      const current = worker ??= new Worker(new URL("./telemetry-writer.ts", import.meta.url));
      function done() {
        current.off("message",done);
        current.off("error",failed);
        current.off("exit",failed);
        current.unref();
        resolve();
      }
      function failed() { worker = undefined; done(); }
      current.ref();
      current.once("message",done);
      current.once("error",failed);
      current.once("exit",failed);
      current.postMessage({event,trace});
    });
  }
  return {
    record(event:GraphTelemetryEvent) {
      const trace = process.env.GENTLE_BENCH_ENGINE_TRACE;
      if (process.env.GENTLE_GRAPH_TELEMETRY !== "1" && !process.env.GENTLE_ABC_ARM && !trace) return;
      tail = tail.then(async () => {
        if (!worker) await nextTurn();
        await write(event,trace);
      }).catch(() => {});
    },
    async close() {
      await tail;
      await worker?.terminate();
      worker = undefined;
    }
  };
}
