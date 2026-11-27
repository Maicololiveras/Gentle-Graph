import fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function deviceSession(cli) {
  const resolve = createRequire(cli).resolve;
  const { openaiCodexProvider } = await import(pathToFileURL(resolve("@earendil-works/pi-ai/providers/openai-codex")));
  const oauth = openaiCodexProvider().auth.oauth;
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

export async function runPi(cli, args, cwd, env, log, access, probe = false) {
  if (!access) throw Error("Missing benchmark access grant.");
  const fd = fs.openSync(log, "w");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./abc-pi.mjs", import.meta.url)), cli, ...args], {
        cwd, env, windowsHide: true, stdio: ["pipe", fd, fd, "ipc"],
      });
      const timer = probe ? setTimeout(() => child.kill(), 90_000) : undefined;
      child.once("error", reject);
      child.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
      child.send(access, error => { if (error) { child.kill(); reject(error); } });
      if (!probe) child.stdin.end();
    });
  } finally { fs.closeSync(fd); }
}
