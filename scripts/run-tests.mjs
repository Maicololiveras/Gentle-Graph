import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(path.join(root, "tests"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map(entry => path.join("tests", entry.name))
  .sort();

if (files.length === 0) throw new Error("No tests/*.test.ts files found");
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
