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
    assert.equal(formatGuide(guide).length, 2400);
    assert.equal(formatInspect(inspect).length, 3000);
    assert.equal(formatImpact(impact).length, 2000);
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
  fs.writeFileSync(file, "export function hot() { return targetFn(); }");
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
  for (let i = 0; i < 90; i++) fs.writeFileSync(path.join(other, `f${i}.ts`), `export function f${i}() { return targetFn(); }`);
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
