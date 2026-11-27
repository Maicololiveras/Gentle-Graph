import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  graphGuide,
  graphImpact,
  graphInspect,
  graphRegisterPattern,
  graphStatus
} from "../lib/gentle-graph/index.ts";
import { clearMemoryCache } from "../lib/gentle-graph/store.ts";

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gentle-graph-test-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });

  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Reglas del proyecto\nReutiliza utilidades existentes.\n");
  fs.writeFileSync(path.join(dir, "contracts/auth-contract.md"), "# Contrato de autenticación\n");

  fs.writeFileSync(
    path.join(dir, "src/auth.ts"),
    `/**
 * @gentle-domain auth
 * @gentle-reuse Usar siempre verifyToken para validar JWT en rutas protegidas
 * @gentle-boundary No decodificar JWT manualmente fuera de src/auth.ts
 */
export function verifyToken(token: string): boolean {
  return decodeHeader(token) !== "";
}

function decodeHeader(raw: string): string {
  return raw.trim();
}
`
  );

  fs.writeFileSync(
    path.join(dir, "src/middleware.ts"),
    `import { verifyToken } from "./auth.ts";

export function requireSession(token: string): boolean {
  return verifyToken(token);
}
`
  );

  fs.writeFileSync(
    path.join(dir, "src/router.ts"),
    `import { requireSession } from "./middleware.ts";

export function handleRequest(token: string): string {
  return requireSession(token) ? "ok" : "denied";
}
`
  );

  fs.writeFileSync(
    path.join(dir, "tests/auth.test.ts"),
    `import { verifyToken } from "../src/auth.ts";
export const ok = verifyToken("abc");
`
  );

  return dir;
}

describe("Gentle Graph", () => {
  it("indexa símbolos, callers, callees y snippet con depth=2", () => {
    const root = makeTempProject();
    try {
      const inspected = graphInspect("verifyToken", { projectRoot: root, depth: 2 });
      assert.equal(inspected.length, 1);
      assert.equal(inspected[0].symbol.file, "src/auth.ts");
      assert.ok(inspected[0].callees.some((c) => c.name === "decodeHeader"));
      assert.ok(inspected[0].callers.some((c) => c.name === "requireSession" && c.hop === 1));
      assert.ok(inspected[0].callers.some((c) => c.name === "handleRequest" && c.hop === 2));
      assert.ok(inspected[0].snippet.includes("verifyToken"));
    } finally {
      clearMemoryCache(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("calcula radio de impacto directo, transitivo y tests relacionados", () => {
    const root = makeTempProject();
    try {
      const impact = graphImpact("verifyToken", { projectRoot: root });
      assert.ok(impact.affectedFiles.includes("src/middleware.ts"));
      assert.ok(impact.affectedFiles.includes("src/router.ts"));
      assert.ok(impact.relatedTests.includes("tests/auth.test.ts"));
    } finally {
      clearMemoryCache(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recomienda módulos existentes, patrones y detecta patrones obsoletos", () => {
    const root = makeTempProject();
    try {
      graphRegisterPattern(
        "auth",
        "src/auth.ts#verifyToken",
        "Reutiliza verifyToken antes de crear validadores nuevos",
        ["src/auth.ts"],
        root
      );

      const guide = graphGuide("validar token de autenticacion en middleware", { projectRoot: root });
      assert.ok(guide.recommendedModules.some((m) => m.file === "src/auth.ts"));
      assert.equal(guide.matchingPatterns.length, 1);
      assert.ok(guide.relevantDocs.includes("contracts/auth-contract.md"));

      // Eliminar el archivo y verificar detección automática de patrón obsoleto
      fs.unlinkSync(path.join(root, "src/auth.ts"));
      const status = graphStatus(root);
      assert.equal(status.stalePatterns, 1);
    } finally {
      clearMemoryCache(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import { SYNC_TTL_MS, syncGraphIndex } from "../lib/gentle-graph/indexer.ts";
import { formatGuide, formatInspect, formatImpact } from "../lib/gentle-graph/format.ts";

it("reuses a worktree index within its TTL, then invalidates reverse lookups", async () => {
  const root = makeTempProject();
  const other = makeTempProject();
  try {
    for (const file of ["big.ts", "library.min.js", "library.bundle.ts"]) {
      fs.writeFileSync(path.join(root, file), file === "big.ts" ? "x".repeat(262145) : "export function ignored() {}");
    }
    const first = syncGraphIndex(root);
    assert.equal(first.stats.updated, 4);
    assert.equal(syncGraphIndex(root).stats.scanned, 0);
    const disk = fs.readFileSync(path.join(root, ".gentle-graph/index.json"), "utf8");
    assert.equal(disk, JSON.stringify(JSON.parse(disk)));
    assert.equal(graphInspect("verifyToken", { projectRoot: root }).length, 1);
    fs.writeFileSync(path.join(other, "src/auth.ts"), "export function otherOnly() {}");
    assert.equal(graphInspect("verifyToken", { projectRoot: other }).length, 0);
    fs.unlinkSync(path.join(root, "src/auth.ts"));
    await new Promise(resolve => setTimeout(resolve, SYNC_TTL_MS + 25));
    assert.equal(graphInspect("verifyToken", { projectRoot: root }).length, 0);
    assert.equal(syncGraphIndex(root).stats.scanned, 0);
  } finally {
    for (const dir of [root, other]) {
      clearMemoryCache(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

it("finds re-export dependents and bounds all compact read-tool responses", () => {
  const root = makeTempProject();
  try {
    fs.writeFileSync(path.join(root, "src/public.ts"), 'export { verifyToken } from "./auth";');
    fs.writeFileSync(path.join(root, "tests/public.test.ts"), 'import "../src/public";');
    const opts = { projectRoot: root };
    const impact = graphImpact("src/auth.ts", opts);
    assert.ok(impact.relatedTests.includes("tests/public.test.ts"));
    const inspect = graphInspect("verifyToken", opts);
    const guide = graphGuide("auth", opts);
    const long = "x".repeat(5000);
    inspect[0].snippet = long;
    impact.affectedFiles.push(long);
    guide.recommendedModules[0].reuseNotes.push(long);
    for(const [output,max] of [[formatGuide(guide),1199],[formatInspect(inspect),3000],[formatImpact(impact),2000]] as const){
      assert.ok(Buffer.byteLength(output)<=max);
      assert.ok(output.endsWith("\n…"));
      assert.ok(!output.includes("xxx"));
    }
  } finally {
    clearMemoryCache(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { execFileSync } from "node:child_process";
import { loadGraphIndex } from "../lib/gentle-graph/store.ts";

function git(root: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=Graph Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "pipe" });
}

function largeRepo(t: import("node:test").TestContext, count = 550) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-jit-"));
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, { recursive: true, force: true }); });
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), ".gentle-graph/\nignored/\n");
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `f${i}.ts`), `export function f${i}() {}\n`);
  for (const [file, source] of Object.entries({
    "billing.ts": 'import { helper } from "./support";\nexport function targetFn() { return helper(); }',
    "support.ts": "export function helper() {}",
    "caller.ts": 'import { targetFn } from "./billing";\nexport function indirect() { return targetFn(); }',
    "entry.ts": 'import { indirect } from "./caller";\nexport function start() { return indirect(); }'
  })) fs.writeFileSync(path.join(root, file), source);
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

it("limits a cold guide to the relevant neighborhood and follows relative imports", t => {
  const root = largeRepo(t);
  const guide = graphGuide("billing", { projectRoot: root });
  assert.ok(guide.recommendedModules.some(m => m.file === "billing.ts"));
  const state = syncGraphIndex(root);
  assert.equal(state.mode, "jit");
  assert.equal(state.knownFiles.length, 554);
  assert.ok(Object.keys(state.index.files).length < 40);
  assert.ok(state.index.files["support.ts"]);
});

it("discovers cold callers and transitive importers with full-index parity", t => {
  const root = largeRepo(t);
  const opts = { projectRoot: root };
  graphGuide("billing", opts);
  assert.ok(!loadGraphIndex(root).files["caller.ts"]);
  const impact = graphImpact("targetFn", opts);
  assert.ok(impact.affectedFiles.includes("caller.ts"));
  assert.ok(impact.affectedFiles.includes("entry.ts"));
  assert.ok(loadGraphIndex(root).files["caller.ts"]);
  const inspection = graphInspect("billing.ts#targetFn", { ...opts, depth: 2 });
  assert.ok(inspection[0].callers.some(c => c.name === "start"));
  assert.ok(Object.keys(loadGraphIndex(root).files).length < 40);
  syncGraphIndex(root, { fullSync: true });
  assert.deepEqual(graphImpact("targetFn", opts), impact);
});

it("picks up untracked, edited and deleted source on the next JIT query", t => {
  const root = largeRepo(t);
  graphGuide("billing", { projectRoot: root });
  const file = path.join(root, "new caller.ts");
  fs.writeFileSync(file, 'import {targetFn} from "./billing";\nexport function hot() { return targetFn(); }');
  assert.ok(graphImpact("targetFn", { projectRoot: root }).directCallers.some(c => c.name === "hot"));
  fs.writeFileSync(file, "export function replacement() {}");
  graphGuide("billing", { projectRoot: root });
  assert.equal(loadGraphIndex(root).files["new caller.ts"].symbols[0]?.name, "replacement");
  fs.unlinkSync(file);
  graphGuide("billing", { projectRoot: root });
  assert.ok(!loadGraphIndex(root).files["new caller.ts"]);
  assert.ok(Object.keys(loadGraphIndex(root).files).length < 40);
});

it("returns all callers past the grep cap and keeps linked worktrees independent", t => {
  const root = largeRepo(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "graph-worktree-"));
  t.after(() => { clearMemoryCache(other); fs.rmSync(other, { recursive: true, force: true }); });
  git(root, "worktree", "add", "--detach", other, "HEAD");
  for (let i = 0; i < 90; i++) fs.writeFileSync(path.join(other, `f${i}.ts`), `import {targetFn} from "./billing";\nexport function f${i}() { return targetFn(); }`);
  assert.equal(graphImpact("targetFn", { projectRoot: other }).directCallers.length, 91);
  assert.equal(graphImpact("targetFn", { projectRoot: root }).directCallers.length, 1);
});

it("runs all read tools outside Git", t => {
  const root = makeTempProject();
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(syncGraphIndex(root).mode, "full");
  assert.ok(graphGuide("auth", { projectRoot: root }).recommendedModules.length);
  assert.ok(graphInspect("verifyToken", { projectRoot: root }).length);
  assert.ok(graphImpact("verifyToken", { projectRoot: root }).relatedTests.length);
});

it("switches above 500 files, respects gitignore and scopes nested projects", t => {
  const root = largeRepo(t, 496);
  assert.equal(syncGraphIndex(root).mode, "full");
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(nested, "ignored"));
  fs.writeFileSync(path.join(nested, "ignored", "secret.ts"), "export function hidden() {}");
  fs.writeFileSync(path.join(nested, "-active.ts"), "export function active() {}");
  clearMemoryCache(root);
  const state = syncGraphIndex(root);
  assert.equal(state.mode, "jit");
  assert.equal(state.knownFiles.length, 501);
  const inner = syncGraphIndex(nested);
  assert.deepEqual(inner.knownFiles, ["-active.ts"]);
});

it("retains independent registrations from simultaneous processes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = makeTempProject();
  try {
    const module = new URL("../lib/gentle-graph/arch-guide.ts", import.meta.url).href;
    await Promise.all(Array.from({length: 8}, (_, i) => run(process.execPath, ["--input-type=module", "-e",
      'import {registerPattern} from '+JSON.stringify(module)+'; registerPattern(process.argv[1],"domain",process.argv[2],"reuse")', root, "file"+i])));
    const guide = JSON.parse(fs.readFileSync(path.join(root,".gentle-graph/guide.json"),"utf8"));
    assert.equal(new Set(guide.patterns.map(p=>p.entry)).size, 8);
  } finally { fs.rmSync(root,{ recursive:true, force:true }); }
});

it("reopens a large WAL index, updates and removes individual entries", async () => {
  const { loadGraphIndex, saveGraphIndex } = await import("../lib/gentle-graph/store.ts");
  const root = makeTempProject();
  try {
    const index = loadGraphIndex(root);
    for (let i=0; i<2001; i++) {
      const file = i+".ts";
      index.files[file] = {path:file,language:"typescript",mtimeMs:1,sha256:"fixture",imports:[],exports:[],symbols:[]};
    }
    saveGraphIndex(root,index,new Set(Object.keys(index.files)));
    assert(fs.existsSync(path.join(root,".gentle-graph/index.sqlite")));
    clearMemoryCache(root);
    const reopened = loadGraphIndex(root);
    assert.equal(Object.keys(reopened.files).length,2001);
    delete reopened.files["1.ts"];
    reopened.files["2.ts"].mtimeMs++;
    saveGraphIndex(root,reopened,new Set(["1.ts","2.ts"]));
    clearMemoryCache(root);
    const updated = loadGraphIndex(root);
    assert.equal(updated.files["1.ts"],undefined);
    assert.equal(updated.files["2.ts"].mtimeMs,2);
  } finally { clearMemoryCache(root); fs.rmSync(root,{ recursive:true, force:true }); }
});

it("JIT literal search includes untracked source files and ignores graph artifacts", async () => {
  const { gitGrepFiles, grepImpactProjection, gitPathsSync, cleanLiteralHits } = await import("../lib/gentle-graph/git-scope.ts");
  const { execFileSync } = await import("node:child_process");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"graph-grep-"));
  try {
    execFileSync("git",["init","-q"],{cwd:dir});
    fs.mkdirSync(path.join(dir,"src"));
    fs.mkdirSync(path.join(dir,".gentle-graph"));
    fs.writeFileSync(path.join(dir,"src","query.TS"),"export const value='-port[5]';");
    fs.writeFileSync(path.join(dir,"client.py"),"query = 'alpha'");
    fs.writeFileSync(path.join(dir,"note.md"),"alpha");
    fs.writeFileSync(path.join(dir,".gentle-graph","generated.ts"),"alpha");
    assert.deepEqual((await gitGrepFiles(dir,["alpha","-port[5]"],Infinity))?.sort(),["client.py","src/query.TS"]);
    fs.writeFileSync(path.join(dir,"src","entry.ts"),"import './alpha';\r\nimport './other';\r\nalpha();");
    const combined=await grepImpactProjection(dir,"alpha");
    const {projectionArgs,projectionPattern}=await import("../lib/gentle-graph/git-projection.ts");
    assert.deepEqual(combined?.hits.sort(),["client.py","src/entry.ts"]);
    assert.deepEqual((await grepImpactProjection(dir,"alpha",true))?.hits,[]);
    assert.deepEqual(combined?.projection,gitPathsSync(dir,projectionArgs,true,projectionPattern));
    execFileSync("git",["add","src","client.py"],{cwd:dir});
    const tracked=["src/entry.ts","src/query.TS","client.py"];
    assert.deepEqual((await cleanLiteralHits(dir,"alpha",tracked))?.sort(),["client.py","src/entry.ts"]);
    fs.writeFileSync(path.join(dir,".gitattributes"),"*.ts filter=custom-text\n");
    assert.equal(await cleanLiteralHits(dir,"alpha",tracked),null);
    fs.writeFileSync(path.join(dir,"src","entry.ts"),"import './beta';\nbeta();");
    assert.deepEqual((await grepImpactProjection(dir,"alpha"))?.hits,["client.py"]);
    const working=await grepImpactProjection(dir,"beta");
    assert.deepEqual(working?.hits,["src/entry.ts"]);
    assert.deepEqual(await grepImpactProjection(dir,"beta",true),working);
    assert.deepEqual(working?.projection,gitPathsSync(dir,projectionArgs,true,projectionPattern));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

it("ranks a relevant imported implementation used by the entry among the first three", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guide-import-"));
  try {
    const files = {
      "invoice-delivery-router.ts":"import { sendInvoice } from './transport.ts';\nimport { renderInvoice } from './unused.ts';\nexport function invoiceDeliveryRouter() { return sendInvoice(); }",
      "invoice-delivery-status.ts":"export function invoiceDeliveryStatus() {}",
      "invoice-delivery-log.ts":"export function invoiceDeliveryLog() {}",
      "transport.ts":"export function sendInvoice() {}",
      "unused.ts":"export function renderInvoice() {}"
    };
    for (const [file,content] of Object.entries(files)) fs.writeFileSync(path.join(root,file),content);
    const modules = (limit:number) => graphGuide("invoice delivery router",{projectRoot:root,limit}).recommendedModules.map(m=>m.file);
    assert.deepEqual(modules(1),["invoice-delivery-router.ts"]);
    assert(modules(3).includes("transport.ts"));
    assert(!modules(3).includes("unused.ts"));
    assert.equal(new Set(modules(5)).size,5);
  } finally { clearMemoryCache(root); fs.rmSync(root,{recursive:true,force:true}); }
});

it("promotes a called operation matching the intent ahead of a generic config helper", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guide-called-"));
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, {recursive:true, force:true}); });
  const files = {
    "invoice-routing-router.ts": "import { loadInvoice } from './service.ts';\nimport { configHome } from './config-home.ts';\nexport function invoiceRouter() { return loadInvoice(configHome()); }",
    "invoice-router-policy.ts": "export function invoiceRouterPolicy() {}",
    "service.ts": "export function loadInvoice() {}",
    "config-home.ts": "export function configHome() {}"
  };
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root,file),body);
  const promoted = (intent:string) => graphGuide(intent,{projectRoot:root,limit:3}).recommendedModules.map(m=>m.file);
  assert.ok(promoted("invoice routing router config loading").includes("service.ts"));
  assert.ok(promoted("invoice routing router config home").includes("config-home.ts"));
});

it("reuses Git searches and invalidates them on repeated edits of a dirty file", async t => {
  const {gitSnapshot, gitGrepFiles, clearGitSession} = await import("../lib/gentle-graph/git-scope.ts");
  const root = largeRepo(t, 1);
  t.after(clearGitSession);
  const file = path.join(root,"caller.ts");
  fs.appendFileSync(file,"\n// firstNeedle");
  const state = await gitSnapshot(root);
  assert.deepEqual(await gitGrepFiles(root,"firstNeedle",80,state),["caller.ts"]);
  assert.strictEqual(await gitSnapshot(root),state);
  assert.deepEqual(await gitGrepFiles(root,["firstNeedle","firstNeedle"],1,state),["caller.ts"]);
  assert.equal(state.greps.size,1);
  fs.writeFileSync(file,"// replacementNeedle");
  assert.notStrictEqual(await gitSnapshot(root),state);
  assert.deepEqual(await gitGrepFiles(root,"firstNeedle"),[]);
});

it("marks exhausted impact searches as partial", t => {
  const root=makeTempProject();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(graphImpact("verifyToken",{projectRoot:root,budgetMs:0}).partial,true);
});

it("omits fixture paths and caps intent-related guide documents", t => {
  const root=makeTempProject();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"contracts","fixtures"));
  for(const name of ["auth.fixture.json","fixtures/auth.md","auth.snap","auth-service.md","auth-policy.md","calendar.md"])
    fs.writeFileSync(path.join(root,"contracts",name),"auth");
  const result=graphGuide("auth",{projectRoot:root});
  assert.equal(result.relevantDocs.length,2);
  assert.ok(result.relevantDocs.every(f=>f.includes("auth")));
  assert.doesNotMatch(JSON.stringify([result.boundaries,result.relevantDocs]),/fixture|\.snap|calendar/);
});

it("coalesces concurrent host queries and releases workers on shutdown", async t=>{
  const {sessionQuery,closeQuerySessions}=await import("../lib/gentle-graph/query-session.ts");
  const root=makeTempProject();
  t.after(async()=>{await closeQuerySessions();fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,"tsconfig.json"),"{}");
  const q={kind:"inspect" as const,root,term:"verifyToken"};
  const first=sessionQuery(q);
  assert.equal(first,sessionQuery(q));
  const result=await first;
  assert.match(result,/src\/auth.ts/);
  clearMemoryCache(root);
  fs.rmSync(path.join(root,".gentle-graph"),{recursive:true,force:true});
  const {formatInspect}=await import("../lib/gentle-graph/format.ts");
  assert.equal(result,formatInspect(graphInspect(q.term,{projectRoot:root})));
});

it("refreshes a worker result when a dirty source is edited again", async t=>{
  const {sessionQuery,closeQuerySessions}=await import("../lib/gentle-graph/query-session.ts");
  const root=largeRepo(t,1);
  const file=path.join(root,"caller.ts");
  const q={kind:"inspect" as const,root,term:"editableCaller"};
  try {
    fs.writeFileSync(file,"export function editableCaller() { return 12; }");
    assert.match(await sessionQuery(q),/return 12/);
    fs.writeFileSync(file,"export function editableCaller() { return 234; }");
    assert.match(await sessionQuery(q),/return 234/);
  } finally {await closeQuerySessions();}
});

it("reports a broken Git index and recovers on the next session query", {timeout:15000}, async t => {
  const root = largeRepo(t, 1);
  const {sessionQuery, closeQuerySessions} = await import("../lib/gentle-graph/query-session.ts");
  const indexPath = path.join(root, ".git", "index");
  const original = fs.readFileSync(indexPath);
  fs.writeFileSync(indexPath, "broken Git index");
  assert.equal(syncGraphIndex(root).degraded,true);
  assert.deepEqual(graphGuide("billing",{projectRoot:root}).recommendedModules,[]);
  try {
    assert.doesNotMatch(await sessionQuery({root,kind:"guide",term:"billing"}), /billing\.ts/);
    assert.equal(fs.existsSync(path.join(root, ".gentle-graph", "index.json")), false);
    fs.writeFileSync(indexPath, original);
    assert.match(await sessionQuery({root,kind:"guide",term:"billing"}), /billing\.ts/);
  } finally { await closeQuerySessions(); }
});

it("keeps the persisted snapshot when only a source timestamp changes", t => {
  const root = makeTempProject();
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, {recursive: true, force: true}); });
  const {index} = syncGraphIndex(root);
  const disk = path.join(root, ".gentle-graph", "index.json");
  const snapshot = fs.readFileSync(disk, "utf8");
  const source = path.join(root, "src", "auth.ts");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(source, future, future);
  const {stats} = syncGraphIndex(root, {fullSync: true});
  assert.equal(stats.updated, 0);
  assert.equal(index.files["src/auth.ts"].mtimeMs, fs.statSync(source).mtimeMs);
  assert.equal(fs.readFileSync(disk, "utf8"), snapshot);
});

it("prunes name-only matches while following aliases, barrels and private local callers", t=>{
  const root=largeRepo(t);
  const put=(name:string,source:string)=>fs.writeFileSync(path.join(root,name),source);
  put("overlay.ts","export function loadToolOverlays() { return 1; }");
  put("barrel.ts",'export {loadToolOverlays as load} from "./overlay";');
  put("consumer.ts",'import {load as read} from "./barrel";\nfunction get() { return read(); }\nexport function discoverAgentsIn(){ return get(); }\nexport function unrelated(){return other.read();}');
  put("second.ts",'import {discoverAgentsIn} from "./consumer";\nexport function main(){return discoverAgentsIn();}');
  for(let i=0;i<220;i++)put("f"+i+".ts",`// loadToolOverlays\nexport function unrelated${i}(){ return get(); }`);
  git(root,"add",".");
  git(root,"commit","-qm","module proof");
  const impact=graphImpact("loadToolOverlays",{projectRoot:root});
  assert.ok(!impact.partial);
  assert.deepEqual(impact.directCallers.map(s=>s.name),["get"]);
  assert.deepEqual(impact.transitiveCallers.map(s=>s.name),["discoverAgentsIn","main"]);
  assert.deepEqual([...impact.affectedFiles].sort(),["barrel.ts","consumer.ts","second.ts"]);
  assert.ok(Object.keys(loadGraphIndex(root).files).length<15);
});

it("matches Git's tracked, untracked, staged and unstaged paths across index layouts", async t => {
  const {gitWorkspaceInventory,gitInventory,gitDirtyFilesSync} = await import("../lib/gentle-graph/git-scope.ts");
  const {readTrackedIndexPaths} = await import("../lib/gentle-graph/git-index-paths.ts");
  const root=largeRepo(t);
  git(root,"update-index","--index-version=2");
  fs.writeFileSync(path.join(root,"f1.ts"),"export const staged = true;");
  git(root,"add","f1.ts");
  fs.writeFileSync(path.join(root,"f2.ts"),"export const dirty = true;");
  fs.writeFileSync(path.join(root,"pending.ts"),"export const pending = true;");
  const plain=gitInventory(root);
  const native=gitWorkspaceInventory(root);
  assert.deepEqual(native.files,plain.files);
  assert.deepEqual(new Set(native.dirty),new Set(gitDirtyFilesSync(root,plain.untracked)));
  assert.deepEqual(readTrackedIndexPaths(root),plain.files.filter(file=>!plain.untracked.includes(file)));
  fs.mkdirSync(path.join(root,"nested"));
  assert.equal(readTrackedIndexPaths(path.join(root,"nested")),undefined);
  const linked=fs.mkdtempSync(path.join(os.tmpdir(),"gg-native-linked-"));
  git(root,"worktree","add","--detach",linked,"HEAD");
  t.after(()=>fs.rmSync(linked,{recursive:true,force:true}));
  assert.equal(readTrackedIndexPaths(linked),undefined);

  git(root,"update-index","--index-version=4");
  assert.equal(readTrackedIndexPaths(root),undefined);
  assert.deepEqual(gitWorkspaceInventory(root).files,gitInventory(root).files);
  git(root,"update-index","--index-version=2");
  git(root,"update-index","--skip-worktree","f3.ts");
  assert.equal(readTrackedIndexPaths(root),undefined);
  git(root,"update-index","--no-skip-worktree","f3.ts");
  git(root,"update-index","--split-index");
  assert.equal(readTrackedIndexPaths(root),undefined);
  assert.deepEqual(gitWorkspaceInventory(root).files,gitInventory(root).files);
});

it("keeps Go package-private transitive callers inside their package", t=>{
  const root=largeRepo(t);
  for(const dir of ["engine","other"])fs.mkdirSync(path.join(root,dir));
  const put=(file:string,src:string)=>fs.writeFileSync(path.join(root,file),src);
  put("engine/root.go","package engine\nfunc CalculateThing() {}\nfunc get() { CalculateThing() }");
  put("engine/caller.go","package engine\nfunc Execute() { get() }");
  put("other/noise.go","package other\nfunc get() {}\nfunc Detached() { get() }");
  git(root,"add",".");
  git(root,"commit","-qm","Go package scope");
  const result=graphImpact("CalculateThing",{projectRoot:root});
  assert.ok(result.transitiveCallers.some(s=>s.name==="Execute"));
  assert.ok(!result.transitiveCallers.some(s=>s.name==="Detached"));
  assert.ok(!loadGraphIndex(root).files["other/noise.go"]);
});
import "./sqlite-store.test.ts";


it("keeps the guide direct and hides secondary declarations only alongside codemode",async()=>{
  const {default:register}=await import("../extensions/gentle-graph.ts");
  const tools=new Map();
  register({registerTool:tool=>tools.set(tool.name,tool),on:()=>{}} as any);
  assert.equal(tools.get("graph_guide").prepareLoadout,undefined);
  for(const name of ["graph_impact","graph_inspect","graph_register_pattern"]){
    const {prepareLoadout}=tools.get(name);
    assert.equal(prepareLoadout({declared:[{name}]}),undefined);
    assert.equal(prepareLoadout({declared:[{name:"codemode"}]}),undefined);
    assert.deepEqual(prepareLoadout({declared:[{name},{name:"codemode"}]}),{hiddenDeclarations:[name]});
  }
});

it("reports cold query telemetry and finds an untracked consumer in a fresh worktree",async t=>{
  const root=largeRepo(t);
  fs.writeFileSync(path.join(root,"tsconfig.json"),"{}");
  fs.writeFileSync(path.join(root,"extra.test.ts"),'import { targetFn } from "./billing";\nexport function newConsumer(){return targetFn();}');
  const {sessionQueryDetails,closeQuerySessions}=await import("../lib/gentle-graph/query-session.ts");
  try {
    const query={kind:"impact" as const,root,term:"targetFn"};
    const first=await sessionQueryDetails(query);
    assert.equal(first.mode,"jit");
    assert.equal(first.partial,false);
    assert.ok(first.indexed>0 && first.indexed<40);
    assert.match(first.text,/extra\.test\.ts/);
    assert.deepEqual(await sessionQueryDetails(query),first);
  }finally{await closeQuerySessions();}
});

it("rechecks preview contents before publishing the selected guide files", async t => {
  const {previewTrackedGuide} = await import("../lib/gentle-graph/query-guide.ts");
  const {indexSpecificFiles} = await import("../lib/gentle-graph/indexer.ts");
  const root = makeTempProject();
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const file = "src/auth.ts";
  const paths = [file, ...Array.from({length:500}, (_, i) => "src/mod" + i + ".ts")];
  const prepared = previewTrackedGuide(root, "auth", paths);
  assert.ok(prepared?.[file].exports.includes("verifyToken"));
  assert.equal(fs.existsSync(path.join(root, ".gentle-graph/index.json")), false);
  fs.writeFileSync(path.join(root, file), "export function checkToken() {}\n");
  const {index} = indexSpecificFiles(root, [file], {paths:new Set(paths), prepared, preview:true});
  assert.deepEqual(index.files[file].exports, ["checkToken"]);
});
