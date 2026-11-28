import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { ParsedFile } from "./languages/types.ts";

export interface CompilerConnection {
  port: MessagePort;
  signal: Int32Array;
}
let connection: CompilerConnection | undefined;

export function attachCompiler(connectionFromParent: CompilerConnection) {
  connection = connectionFromParent;
}

// Only the query worker has a connection. Fall back to local parsing on
// failure and retire the port so a late reply cannot satisfy the next file.
export function parseWithCompilerWorker(file: string, content: string): ParsedFile | undefined {
  if (!connection) return;
  const {port, signal} = connection;
  const version = Atomics.load(signal, 0);
  if (!Atomics.load(signal, 1)) {
    port.postMessage({file, content});
    if (Atomics.wait(signal, 0, version, 4000) !== "timed-out") {
      const reply = receiveMessageOnPort(port)?.message;
      if (reply?.parsed) return reply.parsed;
    }
  }
  port.close();
  connection = undefined;
}
