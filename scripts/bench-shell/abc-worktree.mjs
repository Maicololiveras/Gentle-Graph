import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";

export function capturePatch(cwd) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "abc-patch-"));
  const exclusions = ["node_modules", ".gentle-graph", ".codegraph"].map(p => ":(top,exclude)" + p);
  const options = {cwd, windowsHide:true, maxBuffer:64*1024*1024};
  const git = (args, extra) => execFileSync("git", args, {...options, ...extra});
  try {
    const actual = git(["rev-parse","--path-format=absolute","--git-path","index"]).toString().trimEnd();
    const index = path.join(temp, "index");
    fs.copyFileSync(actual, index);
    const env = {...process.env, GIT_INDEX_FILE:index};
    const paths = git(["ls-files","--others","--exclude-standard","-z","--",".",...exclusions], {env});
    if (paths.length) git(["--literal-pathspecs","add","-N","--pathspec-from-file=-","--pathspec-file-nul"], {env,input:paths});
    return git(["diff","--no-ext-diff","--binary","HEAD","--",".",...exclusions], {env});
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
}

export async function cleanWorktrees(worktrees, remove, retained = new Set()) {
  const errors = [];
  for (const [root,cwd] of [...worktrees].reverse()) {
    if (retained.has(cwd)) continue;
    for (const wait of [0,150,450,1000]) {
      if (wait) await delay(wait);
      try {
        const link = path.join(cwd,"node_modules");
        if (fs.lstatSync(link,{throwIfNoEntry:false})?.isSymbolicLink()) fs.unlinkSync(link);
        remove(root,cwd);
        break;
      } catch (error) {
        if (wait === 1000) errors.push({cwd,error:String(error)});
      }
    }
  }
  return errors;
}
