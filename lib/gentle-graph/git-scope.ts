import { execFileSync } from "node:child_process";
import { isIndexableFile } from "./parser-generic.ts";

function gitPaths(root: string, args: string[], grep = false): string[] | null {
  try {
    return execFileSync("git", args, {
      cwd: root, encoding: "utf8", timeout: 4000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    }).split("\0").filter(Boolean);
  } catch (error) {
    if (grep && (error as { status?: number }).status === 1) return [];
    return null;
  }
}

export function gitListIndexableFiles(root: string): string[] | null {
  return gitPaths(root, ["ls-files", "--deduplicate", "-z", "--cached", "--others", "--exclude-standard", "--", "."])?.filter(isIndexableFile) ?? null;
}

export function gitDirtyFiles(root: string): string[] | null {
  const rows = gitPaths(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."]);
  if (!rows?.length) return rows;
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"]
    }).replace(/\r?\n$/, "");
    return rows.map(row => row.slice(3)).filter(file => file.startsWith(prefix))
      .map(file => file.slice(prefix.length)).filter(isIndexableFile);
  } catch {
    return null;
  }
}

export function gitGrepFiles(root: string, literal: string | string[], maxFiles = 80): string[] | null {
  const terms = typeof literal === "string" ? [literal] : literal;
  if (!terms.length) return [];
  const rows = gitPaths(root, ["grep", "--threads=1", "--untracked", "-I", "-z", "-l", "-F",
    ...terms.flatMap(term => ["-e", term]), "--", "."], true);
  return rows?.filter(isIndexableFile).slice(0, maxFiles) ?? null;
}
