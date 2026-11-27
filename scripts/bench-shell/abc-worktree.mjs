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

function registeredWorktree(root, cwd) {
  const output = execFileSync("git", ["-C",root,"worktree","list","--porcelain","-z"], {
    encoding:"utf8", windowsHide:true
  });
  function key(p) {
    let absolute=path.resolve(p);
    try {absolute=fs.realpathSync.native(absolute);}
    catch(error){if(error.code!=="ENOENT")throw error;}
    return process.platform==="win32"?absolute.toLowerCase():absolute;
  }
  return output.split("\0").some(field => field.startsWith("worktree ") && key(field.slice(9)) === key(cwd));
}

export async function cleanWorktrees(worktrees, remove, retained = new Set(), registered = registeredWorktree) {
  const errors = [];
  for (const [root,cwd] of [...worktrees].reverse()) {
    if (retained.has(cwd)) continue;
    let unregistered=false;
    for (const wait of [0,150,450,1000]) {
      if (wait) await delay(wait);
      try {
        const link = path.join(cwd,"node_modules");
        if (fs.lstatSync(link,{throwIfNoEntry:false})?.isSymbolicLink()) fs.unlinkSync(link);
        if (!unregistered) {
          try {
            remove(root,cwd);
          } catch (error) {
            // Git can unregister the checkout before Windows releases its directory.
            if (registered(root,cwd) || fs.existsSync(path.join(cwd,".git"))) throw error;
          }
          unregistered=true;
        }
        // cwd is a disposable checkout created and recorded by this invocation.
        fs.rmSync(path.toNamespacedPath(cwd),{recursive:true,force:true,maxRetries:3,retryDelay:200});
        break;
      } catch (error) {
        if (wait === 1000) errors.push({cwd,error:String(error)});
      }
    }
  }
  return errors;
}
