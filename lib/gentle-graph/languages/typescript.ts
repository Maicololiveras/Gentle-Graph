import path from "node:path";
import { createRequire } from "node:module";
import { findBraceBlockEnd, sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";
import type { SymbolKind } from "../types.ts";

const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const language = (f: string) => /\.[cm]?tsx?$/i.test(f) ? "typescript" : "javascript";
const host = createRequire(import.meta.url);
const modules = new Map<string, any>();
export function workspaceCompiler(root: string) {
  if (process.env.GENTLE_GRAPH_DISABLE_TOOLCHAINS === "1") return;
  const key = process.env.GENTLE_GRAPH_TRUST_WORKSPACE_TYPESCRIPT === "1" ? root : "";
  if (!modules.has(key)) {
    let ts;
    if (key) {
      try { ts = createRequire(path.resolve(key, "package.json"))("typescript"); } catch { /* Try the host. */ }
    }
    try { ts ??= host("typescript"); } catch { /* Lexical adapter is always available. */ }
    modules.set(key, ts);
  }
  return modules.get(key);
}

export function lexicalTS(file: string, content: string) {
  const { lines, clean, result, add } = sourceFile(file, content, language(file));
  let owner = "", until = -1, memberEnd = -1;
  clean.forEach((line, i) => {
    if (/^\s*(?:import|export)\b/.test(line)) {
      const spec = lines[i].match(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/);
      if (spec) result.imports.push(spec[1]);
      if (/^\s*export\s+default\b/.test(line)) result.exports.push("default");
      if (/^\s*export\s*\*/.test(line)) result.exports.push("*");
    }
    const decl = line.match(/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+|async\s+)?(class|function|interface|type)\b\s*(\w+)?/);
    if (decl) {
      const end = findBraceBlockEnd(clean, i, clean.length);
      const name = decl[3] || "default";
      const sym = add(name, decl[2] as SymbolKind, i, end, !!decl[1], decl[2] === "class" ? [] : undefined);
      if (decl[2] === "class") {
        owner = name; until = end; memberEnd = -1;
        const clause = clean.slice(i, Math.min(end + 1, i + 24)).join(" ").split("{")[0].match(/\bimplements\s+(.+)$/);
        if (clause) sym.contracts = clause[1].replace(/<[^<>]*>/g, "").split(",").map(part => part.trim().split(".").at(-1)!);
      }
      return;
    }
    const arrow = line.match(/^\s*(export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/);
    if (arrow) add(arrow[2], "const", i, findBraceBlockEnd(clean, i), !!arrow[1]);
    if (owner && i <= until && i > memberEnd) {
      const method = line.match(/^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([$\w]+)(?:<[^>]*>)?\s*\(/);
      if (method) {
        memberEnd = findBraceBlockEnd(clean, i);
        add(owner + "." + method[1], "method", i, memberEnd, !/\bprivate\b/.test(line));
      }
    }
  });
  return result;
}

function resolveModulePath(base: string, files: Set<string>) {
  if (files.has(base)) return base;
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  for (const extension of extensions) {
    const file = stem + extension;
    if (files.has(file)) return file;
  }
  for (const extension of extensions) {
    const file = base + "/index" + extension;
    if (files.has(file)) return file;
  }
  return null;
}

export const typescript: LanguageAdapter = {
  id: "typescript", extensions, isTestFile: f => /\.(?:test|spec)\.[^/]+$|(?:^|\/)__tests__\//i.test(f),
  resolveRelativeImport(file, spec, files) {
    if (spec.startsWith("$lib/")) {
      let dir = path.posix.dirname(file);
      while (true) {
        const base = path.posix.join(dir,"src/lib",spec.slice(5));
        const hit = resolveModulePath(base, files);
        if (hit) return hit;
        const parent = path.posix.dirname(dir);
        if (parent===dir) return null;
        dir=parent;
      }
    }
    if (!spec.startsWith(".")) return null;
    const base = path.posix.join(path.posix.dirname(file), spec);
    return resolveModulePath(base, files);
  },
  parse(root, file, content) {
    const ts = workspaceCompiler(root);
    if (!ts) return lexicalTS(file, content);
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false);
    const { result, add } = sourceFile(file, content, language(file));
    const locals=new Set<string>(), imports=new Set<string>();
    for(const declaration of sf.statements){
      if(declaration.name?.text) locals.add(declaration.name.text);
      if(ts.isVariableStatement(declaration))
        for(const binding of declaration.declarationList.declarations) if(binding.name?.text) locals.add(binding.name.text);
      if(ts.isImportDeclaration(declaration) && declaration.moduleSpecifier.text.startsWith(".")){
        const clause=declaration.importClause;
        if(clause?.name)imports.add(clause.name.text);
        for(const binding of clause?.namedBindings?.elements??[])imports.add(binding.name.text);
      }
    }
    function record(n:any,name:string,kind:SymbolKind,exported:boolean,collect=true){
      const found=new Set<string>(), local=new Set<string>(), imported=new Set<string>();
      const short=name.split(".").at(-1);
      function walk(node:any){
        if(ts.isCallExpression(node)||ts.isNewExpression(node)){
          const expr=node.expression, target=expr.name?.text??expr.text;
          if(target && target!==short){
            found.add(target);
            if(ts.isIdentifier(expr)){
              if(locals.has(target))local.add(target);
              else if(imports.has(target))imported.add(target);
            } else if(expr.name && (expr.expression.kind===ts.SyntaxKind.ThisKeyword || ts.isIdentifier(expr.expression) && imports.has(expr.expression.text))) imported.add(target);
          }
        }
        ts.forEachChild(node,walk);
      }
      if(collect)walk(n);
      const line=sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const sym=add(name,kind,line,sf.getLineAndCharacterOfPosition(n.end).line,exported,[...found]);
      sym.localCallees=[...local];
      sym.importCallees=[...imported];
      return sym;
    }
    for (const n of sf.statements) {
      const exp = !!n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
      const def = n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (def || ts.isExportAssignment(n)) result.exports.push("default");
      const name = n.name?.text ?? "default";
      if (n.moduleSpecifier?.text) result.imports.push(n.moduleSpecifier.text);
      if (ts.isExportDeclaration(n) && !n.exportClause) result.exports.push("*");
      if (ts.isClassDeclaration(n)) {
        const sym = record(n, name, "class", exp, false);
        const clause = n.heritageClauses?.find((c: any) => c.token === ts.SyntaxKind.ImplementsKeyword);
        if (clause) sym.contracts = clause.types.map((t: any) => t.expression.getText(sf).split(".").at(-1));
        for (const member of n.members) if (ts.isMethodDeclaration(member) && member.name?.text)
          record(member, name + "." + member.name.text, "method", exp && !member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.PrivateKeyword));
      } else if (ts.isFunctionDeclaration(n)) record(n, name, "function", exp);
      else if (ts.isInterfaceDeclaration(n)) record(n, name, "interface", exp, false);
      else if (ts.isTypeAliasDeclaration(n)) record(n, name, "type", exp, false);
      else if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations)
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) record(n, d.name.getText(sf), "const", exp);
    }
    return result;
  }
};
