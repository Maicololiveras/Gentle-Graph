import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { graphGuide } from "../lib/gentle-graph/index.ts";
import { loadGraphIndex } from "../lib/gentle-graph/store.ts";

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
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Benchmark", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture");
  const start = performance.now();
  const result = graphGuide("billing", { projectRoot: root });
  const ms = performance.now() - start;
  if (!result.recommendedModules.some(m => m.file === "billing.ts")) throw new Error("Missing billing module");
  console.log(JSON.stringify({ files: count, indexed: Object.keys(loadGraphIndex(root).files).length, coldGuideMs: +ms.toFixed(1) }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
