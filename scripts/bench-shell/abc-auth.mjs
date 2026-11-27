import fs from "node:fs";
import { spawn } from "node:child_process";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function loadCodexOAuth(cli) {
  const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(cli));
  if (!manifest) throw Error("Pi runtime is missing @earendil-works/pi-ai.");
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const entry = pkg.exports?.["./providers/*"]?.import;
  if (pkg.version !== "1.6.0" || typeof entry !== "string")
    throw Error("Expected the Pi 1.6.0 ESM provider export in " + manifest);
  const file = path.resolve(path.dirname(manifest), entry.replace("*", "openai-codex"));
  const { openaiCodexProvider } = await import(pathToFileURL(file));
  return openaiCodexProvider().auth.oauth;
}

export async function deviceSession(cli) {
  const oauth = await loadCodexOAuth(cli);
  let grant = await oauth.login({
    signal: AbortSignal.timeout(15 * 60_000),
    prompt: async prompt => {
      if (prompt.options?.some(option => option.id === "device_code")) return "device_code";
      throw Error("Pi did not offer device authorization.");
    },
    notify: event => {
      if (event.type === "device_code") console.log("Authorize this benchmark at", event.verificationUri, "using code", event.userCode);
    },
  });
  return async () => {
    if (grant.expires <= Date.now() + 300_000) grant = await oauth.refresh(grant, AbortSignal.timeout(30_000));
    return { access: (await oauth.toAuth(grant)).apiKey, expires: grant.expires };
  };
}

export async function runPi(cli, args, cwd, env, log, access, probe = false, job) {
  if (!access) throw Error("Missing benchmark access grant.");
  const wrapper=fileURLToPath(new URL("./abc-pi.mjs",import.meta.url));
  return runJobChild([wrapper,cli,...args],cwd,env,log,access,probe,job);
}

export async function runJobChild(args,cwd,env,log,message,probe,job) {
  const fd = fs.openSync(log, "w");
  let attached=false;
  try {
      const child = spawn(process.execPath, args, {
        cwd, env, windowsHide: true, stdio: ["pipe", fd, fd, "ipc"],
      });
      const exited = new Promise((resolve,reject)=>{
        child.once("error",reject);
        child.once("exit",code=>resolve(code ?? 1));
      });
      exited.catch(()=>{});
      const timer = probe ? setTimeout(() => child.kill(), 90_000) : undefined;
      try {
        if(job){await job.attach(child.pid);attached=true;}
        await new Promise((resolve,reject)=>child.send(message,error=>error?reject(error):resolve()));
        if (!probe) child.stdin.end();
        return await exited;
      } catch(error){child.kill();throw error;}
      finally {clearTimeout(timer);}
  } finally {
    fs.closeSync(fd);
    if(attached)await job.release();
  }
}
