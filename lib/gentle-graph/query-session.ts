import path from "node:path";
import {existsSync} from "node:fs";
import { MessageChannel, Worker } from "node:worker_threads";

import {prepareColdScope,clearGitSession} from "./git-scope.ts";

export interface Query {
  kind: "guide" | "inspect" | "impact";
  root: string;
  term: string;
  limit?: number;
  depth?: number;
  includeSnippets?: boolean;
}

interface Lane {
  worker?: Worker;
  compiler?: Worker;
  tail: Promise<unknown>;
  stopping?: Promise<number>;
  closed?: boolean;
  pending: Map<string, Promise<string>>;
}

const lanes = new Map<string, Lane>();

async function dispatch(lane: Lane, query: Query): Promise<string> {
  await lane.stopping;
  if (lane.closed) throw new Error("Graph session has ended");
  const cold = !lane.worker;
  const started=process.env.GENTLE_GRAPH_PROFILE==="1"?performance.now():undefined;
  function startWorker() {
    const data = {...query, profileStart:started};
    if (process.platform !== "win32" || query.kind !== "inspect" ||
        process.env.GENTLE_GRAPH_DISABLE_TOOLCHAINS === "1" || !existsSync(path.join(query.root,"tsconfig.json"))) {
      return new Worker(new URL("./query-worker.ts", import.meta.url), {workerData:data});
    }
    const {port1,port2} = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(8));
    const compiler = new Worker(new URL("./compiler-worker.ts", import.meta.url), {
      workerData:{root:query.root,port:port1,signal,profile:started!==undefined},transferList:[port1]
    });
    const unavailable = () => {
      Atomics.store(signal,1,1);
      Atomics.add(signal,0,1);
      Atomics.notify(signal,0);
    };
    lane.compiler=compiler;
    compiler.on("error",unavailable);
    compiler.once("exit",unavailable);
    compiler.unref();
    try {
      const worker = new Worker(new URL("./query-worker.ts",import.meta.url),{
        workerData:{...data,compiler:{port:port2,signal}},transferList:[port2]
      });
      worker.once("exit",()=>{void compiler.terminate();});
      return worker;
    } catch(error) {
      void compiler.terminate();
      throw error;
    }
  }
  const worker = lane.worker ??= startWorker();
  return new Promise((resolve, reject) => {
    let checkpoint = "Partial impact (time budget reached)\n" + query.term;
    const timer = query.kind === "impact" ? setTimeout(() => {
      finish();
      lane.worker = undefined;
      lane.stopping = worker.terminate();
      resolve(checkpoint);
    }, 1500) : undefined;

    function finish() {
      clearTimeout(timer);
      worker.off("message", message);
      worker.off("exit", exit);
      worker.off("error", error);
      worker.unref();
    }

    function error(err: Error) {
      finish();
      if (lane.worker === worker) lane.worker = undefined;
      reject(err);
    }

    function exit(code: number) { error(new Error("Graph worker exited (" + code + ")")); }

    function message(reply: {text?: string; error?: string; checkpoint?: string; timedOut?: boolean}) {
      if (reply.checkpoint) { checkpoint = reply.checkpoint; return; }
      if(started!==undefined)console.error(JSON.stringify({graphProfile:"reply",kind:query.kind,cold,ms:performance.now()-started}));
      finish();
      if (reply.timedOut) resolve(checkpoint);
      else if (reply.error) reject(new Error(reply.error));
      else resolve(reply.text);
    }

    worker.ref();
    worker.on("message", message);
    worker.once("exit", exit);
    worker.once("error", error);
    async function send() {
      // Run the first Git commands while Node loads the language adapters in the worker.
      const prepared = cold ? await prepareColdScope(query.root, query.kind === "inspect" ? query.term : undefined, query.kind === "impact") : undefined;
      if(started!==undefined)console.error(JSON.stringify({graphProfile:"scope",kind:query.kind,cold,ms:performance.now()-started}));
      if (lane.worker === worker && !lane.closed) worker.postMessage({query, prepared, inventoryReady:started === undefined ? undefined : performance.now()});
    }
    send().catch(err => {
      // Git preparation may fail while the new worker is still booting. Keep
      // the healthy worker in its lane for a retry or normal session shutdown.
      if (lane.worker === worker) {
        finish();
        reject(err);
      }
    });
  });
}

export function sessionQuery(input: Query): Promise<string> {
  const query = {...input, root: path.resolve(input.root)};
  let lane = lanes.get(query.root);
  if (!lane) {
    lane = {tail: Promise.resolve(), pending: new Map()};
    lanes.set(query.root, lane);
  }
  const key = JSON.stringify(query);
  const active = lane.pending.get(key);
  if (active) return active;
  const result = lane.tail.catch(() => {}).then(() => dispatch(lane, query));
  lane.pending.set(key, result);
  lane.tail = result;
  const cleanup = () => lane.pending.delete(key);
  result.then(cleanup, cleanup);
  return result;
}

export async function closeQuerySessions() {
  const active = [...lanes.values()];
  lanes.clear();
  clearGitSession();
  await Promise.all(active.map(async lane => {
    lane.closed = true;
    await Promise.all([lane.worker?.terminate(),lane.compiler?.terminate()]);
    await lane.stopping;
    await lane.tail.catch(() => {});
  }));
}
