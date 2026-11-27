// The OS command line and child environment carry no benchmark token.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [cli, ...args] = process.argv.slice(2);
process.once("message", async access => {
  process.disconnect();
  if (!access?.access || !Number.isFinite(access.expires) || access.expires <= Date.now()) throw Error("Missing runtime access grant.");
  const dist = path.dirname(cli);
  const { setupCli } = await import(pathToFileURL(path.join(dist, "cli/setup.js")));
  const { main } = await import(pathToFileURL(path.join(dist, "main.js")));
  // Pi 1.6 CLI does not accept a credential store. Supply its SDK store at
  // runtime creation in this disposable process, preserving normal CLI setup.
  const { AuthStorage } = await import(pathToFileURL(path.join(dist, "core/auth-storage.js")));
  const { ModelRuntime } = await import(pathToFileURL(path.join(dist, "core/model-runtime.js")));
  const credentials = AuthStorage.inMemory({ "openai-codex": { type: "oauth", access: access.access, expires: access.expires, refresh: "" } });
  const create = ModelRuntime.create.bind(ModelRuntime);
  ModelRuntime.create = options => create({ ...options, credentials });
  setupCli();
  await main(args);
});
