import path from "node:path";
import { Worker } from "node:worker_threads";

import {gitSnapshot,gitSessionInventory} from "./git-scope.ts";

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
  const worker = lane.worker ??= new Worker(new URL("./query-worker.ts", import.meta.url));
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
      lane.worker = undefined;
      reject(err);
    }

    function exit(code: number) { error(new Error("Graph worker exited (" + code + ")")); }

    function message(reply: {text?: string; error?: string; checkpoint?: string}) {
      if (reply.checkpoint) { checkpoint = reply.checkpoint; return; }
      finish();
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.text);
    }

    worker.ref();
    worker.on("message", message);
    worker.once("exit", exit);
    worker.once("error", error);
    async function send() {
      // Run the first Git commands while Node loads the language adapters in the worker.
      const prepared = cold ? await Promise.all([
        gitSnapshot(query.root), gitSessionInventory(query.root,null)
      ]) : undefined;
      if (lane.worker === worker && !lane.closed) worker.postMessage({query, prepared});
    }
    send().catch(error);
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
  await Promise.all(active.map(async lane => {
    lane.closed = true;
    await lane.worker?.terminate();
    await lane.stopping;
    await lane.tail.catch(() => {});
  }));
}
