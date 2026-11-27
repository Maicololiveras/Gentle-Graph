import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectArchitecture } from "../lib/gentle-graph/arch-detector.ts";
import { python } from "../lib/gentle-graph/languages/python.ts";
import { listWorkspaceFiles } from "../lib/gentle-graph/indexer.ts";
import { graphGuide } from "../lib/gentle-graph/index.ts";
import { loadGraphIndex } from "../lib/gentle-graph/store.ts";

if (process.argv[2] === "--sample") {
  const root = process.argv[3];
  const start = performance.now();
  const result = graphGuide("billing", { projectRoot: root });
  const ms = performance.now() - start;
  if (!result.recommendedModules.some(m => m.file === "billing.ts")) throw new Error("Missing billing module");
  const { knownFiles, manifests } = listWorkspaceFiles(root);
  fs.rmSync(path.join(root, ".gentle-graph/profile.json"), { force: true });
  const archStart = performance.now();
  detectArchitecture(root, knownFiles, manifests);
  const architectureMs = performance.now() - archStart;
  const source = "from .repo import load_user\nclass Service:\n    def load(self):\n        return load_user()\n";
  const pythonStart = performance.now();
  for (let i = 0; i < 100; i++) python.parse(root, "service.py", source);
  console.log(JSON.stringify({ indexed: Object.keys(loadGraphIndex(root).files).length, coldGuideMs: ms, architectureMs, pythonMsPerFile: (performance.now()-pythonStart)/100 }));
  process.exit(0);
}
const repetitions = Number(process.argv.slice(3).find(a => !a.startsWith("--")) ?? 7);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Expected a positive repetition count");
const count = Number(process.argv[2] ?? 5000);
if (!Number.isSafeInteger(count) || count < 2) throw new Error("Expected a file count >= 2");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gentle-jit-bench-"));
try {
  for (let i = 1; i < count; i++) {
    const dir = path.join(root, String(Math.floor(i / 250)));
    if (i === 1 || i % 250 === 0) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `mod-${i}.ts`), "export function unrelated() {}\n");
  }
  fs.writeFileSync(path.join(root, "billing.ts"), "export function billing() {}\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", windowsHide:true });
  git("init", "-q");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("-c", "user.name=Benchmark", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture");
  const runs = [];
  for (let i = 0; i < repetitions; i++) {
    fs.rmSync(path.join(root, ".gentle-graph"), { recursive: true, force: true, maxRetries:8, retryDelay:200 });
    runs.push(JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--sample", root], { encoding: "utf8", windowsHide:true })));
  }
  const limits = { coldGuideMs: 150, architectureMs: 15, pythonMsPerFile: 2 };
  const summary = {};
  for (const [key, limit] of Object.entries(limits)) {
    const samples = runs.map(run => run[key]).sort((a,b) => a-b);
    const percentile = p => samples[Math.ceil(samples.length*p)-1];
    summary[key] = { median: percentile(.5), p95: percentile(.95), limit, pass: percentile(.95) < limit };
  }
  console.log(JSON.stringify({ count, node: process.version, platform: process.platform, runs, summary }, null, 2));
  if (process.argv.includes("--check") && Object.values(summary).some(metric => !metric.pass)) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries:8, retryDelay:200 });
}
