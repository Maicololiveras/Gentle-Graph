import fs from "node:fs";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
// Link installed host dependencies only for verification, after the agent exited.
const modules=path.resolve("node_modules");
if(fs.existsSync(modules)) throw new Error("Unexpected worktree node_modules");
fs.symlinkSync(fs.realpathSync(process.env.GENTLE_BENCH_MODULES),modules,process.platform==="win32"?"junction":"dir");
try {
  const gitFiles=args=>execFileSync("git",args,{encoding:"utf8"}).split("\0").filter(Boolean);
  const changedTests=[...new Set([
    ...gitFiles(["diff","--name-only","--diff-filter=ACMR","-z","HEAD","--","tests"]),
    ...gitFiles(["ls-files","--others","--exclude-standard","-z","--","tests"])
  ])].filter(f=>/\.test\.[cm]?[jt]s$/.test(f));
  if(!changedTests.length){ console.error("No regression test file added or modified"); process.exitCode=1; }
  for(const args of [
    ["--test",fileURLToPath(new URL("verify.mjs",import.meta.url))],
    ["--test",...new Set(["tests/agent-tool-overlay.test.ts",...changedTests])],
    [path.join(modules,"typescript/bin/tsc"),"--noEmit","-p","tsconfig.json"]
  ]) {
    const r=spawnSync(process.execPath,args,{stdio:"inherit"});
    if(r.status!==0) process.exitCode=1;
  }
} finally {
  if(process.platform==="win32") fs.rmdirSync(modules);
  else fs.unlinkSync(modules);
}
