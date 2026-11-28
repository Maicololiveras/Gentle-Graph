import { readdirSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(path.join(root, "tests"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map(entry => path.join(root, "tests", entry.name))
  .sort();

if (files.length === 0) throw new Error("No tests/*.test.ts files found");
const results = run({ files, cwd: root });
results.on("test:summary", ({ success }) => { if (!success) process.exitCode = 1; });
pipeline(results, new spec(), process.stdout).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
