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
