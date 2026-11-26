import { createRequire } from "node:module";

import { detectLanguage, parseGenericFile, type ParsedFile } from "./parser-generic.ts";
import type { CodeSymbol, SymbolKind } from "./types.ts";

let cachedTsMod: any = undefined;

function tryLoadTypeScript(): any {
  if (cachedTsMod === undefined) {
    try {
      cachedTsMod = createRequire(import.meta.url)("typescript");
    } catch {
      cachedTsMod = null;
    }
  }
  return cachedTsMod;
}

function extractLeadingTags(sourceText: string, pos: number): {
  reuseTag?: string;
  domainTag?: string;
  boundaryTag?: string;
} {
  const windowStart = Math.max(0, pos - 400);
  const leading = sourceText.slice(windowStart, pos);
  const reuseMatch = leading.match(/@gentle-reuse\s+([^\n*]+)/);
  const domainMatch = leading.match(/@gentle-domain\s+([A-Za-z0-9_-]+)/);
  const boundaryMatch = leading.match(/@gentle-boundary\s+([^\n*]+)/);
  return {
    ...(reuseMatch ? { reuseTag: reuseMatch[1].trim() } : {}),
    ...(domainMatch ? { domainTag: domainMatch[1].trim() } : {}),
    ...(boundaryMatch ? { boundaryTag: boundaryMatch[1].trim() } : {})
  };
}

/**
 * Usa el AST oficial de TypeScript si el runtime ya tiene `typescript` instalado;
 * de lo contrario, cae limpiamente al parser genérico con 0 dependencias externas.
 */
export function parseSourceFile(projectRoot: string, relPath: string, content: string): ParsedFile {
  const language = detectLanguage(relPath) ?? "unknown";
  if (language !== "typescript" && language !== "javascript") {
    return parseGenericFile(relPath, content);
  }

  const ts = tryLoadTypeScript();
  if (!ts) {
    return parseGenericFile(relPath, content);
  }

  try {
    const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true);
    const lines = content.split(/\r?\n/);
    const imports = new Set<string>();
    const exports = new Set<string>();
    const symbols: CodeSymbol[] = [];

    const hasExportModifier = (node: any): boolean =>
      Array.isArray(node.modifiers) &&
      node.modifiers.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);

    const collectCalls = (node: any, selfName: string): string[] => {
      const calls = new Set<string>();
      const walk = (n: any) => {
        if (ts.isCallExpression(n)) {
          let callee = "";
          if (ts.isIdentifier(n.expression)) {
            callee = n.expression.text;
          } else if (ts.isPropertyAccessExpression(n.expression)) {
            callee = n.expression.name.text;
          }
          if (callee && callee !== selfName) calls.add(callee);
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
      return [...calls];
    };

    const addSymbol = (node: any, name: string, kind: SymbolKind, exported: boolean) => {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const firstLine = lines[start - 1]?.trim().slice(0, 160) ?? name;
      const tags = extractLeadingTags(content, node.getStart(sf));
      if (exported) exports.add(name);
      symbols.push({
        id: `${relPath}#${name}`,
        name,
        kind,
        file: relPath,
        line: start,
        endLine: end,
        exported,
        signature: firstLine,
        calls: collectCalls(node, name),
        ...tags
      });
    };

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        imports.add(stmt.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        imports.add(stmt.moduleSpecifier.text);
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        addSymbol(stmt, stmt.name.text, "function", hasExportModifier(stmt));
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        addSymbol(stmt, stmt.name.text, "class", hasExportModifier(stmt));
      } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
        addSymbol(stmt, stmt.name.text, "interface", hasExportModifier(stmt));
      } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
        addSymbol(stmt, stmt.name.text, "type", hasExportModifier(stmt));
      } else if (ts.isVariableStatement(stmt)) {
        const exp = hasExportModifier(stmt);
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            addSymbol(stmt, decl.name.text, "const", exp);
          }
        }
      }
    }

    return {
      language,
      imports: [...imports],
      exports: [...exports],
      symbols
    };
  } catch {
    return parseGenericFile(relPath, content);
  }
}
