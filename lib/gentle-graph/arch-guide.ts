import fs from "node:fs";
import path from "node:path";
import { resolveImport } from "./languages/registry.ts";
import { loadArchGuide, updateArchGuide } from "./store.ts";
import type { GraphIndex, GuideRecommendation, ModuleRecommendation, PatternEntry } from "./types.ts";

const STOP_WORDS = new Set([
  "para", "como", "con", "los", "las", "una", "uno", "del", "que", "por", "sin",
  "the", "and", "for", "with", "from", "into", "that", "this", "add", "new", "use"
]);

/**
 * Tokeniza texto natural e identificadores camelCase / snake_case / kebab-case.
 */
export function tokenizeIntent(text: string): string[] {
  const expanded = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  const raw = expanded
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  const aliases: Record<string, string> = { pantalla: "view", vista: "view", comando: "command", ordenes: "order", servicio: "service" };
  return [...new Set(raw.flatMap(word => aliases[word] ? [word, aliases[word]] : [word]))];
}

export const isFixturePath = (file:string) => /(?:^|[\s\/\\])fixtures[\/\\]|\.fixture\.json\b|\.snap\b/i.test(file);

function findRelevantDocs(projectRoot: string, tokens: string[]): string[] {
  const candidates: string[] = [];
  for (const top of ["AGENTS.md", "README.md"]) {
    if (fs.existsSync(path.join(projectRoot, top))) {
      candidates.push(top);
    }
  }

  for (const dir of ["contracts", "docs", "odd/notes", "odd/tasks"]) {
    const full = path.join(projectRoot, dir);
    if (!fs.existsSync(full)) continue;
    try {
      for (const entry of fs.readdirSync(full)) {
        if (entry.endsWith(".md")) {
          candidates.push(`${dir}/${entry}`);
        }
      }
    } catch {
      // Ignorar directorios no legibles
    }
  }

  return candidates.filter(doc => !isFixturePath(doc)).map(doc=>{
    const words = tokenizeIntent(path.posix.basename(doc, ".md"));
    return { doc, matches:words.filter(w=>tokens.includes(w)).length };
  }).filter(row=>row.matches>0).sort((a,b)=>b.matches-a.matches || a.doc.localeCompare(b.doc)).slice(0,2).map(row=>row.doc);
}

export function rankModules(index: GraphIndex, tokens: string[], limit: number): ModuleRecommendation[] {
  const ranked: ModuleRecommendation[] = Object.values(index.files)
    .map((fileNode) => {
      const pathLower = fileNode.path.toLowerCase();
      const symbolText = fileNode.symbols
        .map((s) => `${s.name} ${s.reuseTag ?? ""} ${s.domainTag ?? ""} ${s.boundaryTag ?? ""}`)
        .join(" ")
        .toLowerCase();

      let score = 0;
      for (const tok of tokens) {
        if (pathLower.includes(tok)) score += 4;
        if (fileNode.exports.some((e) => e.toLowerCase().includes(tok))) score += 3;
        if (symbolText.includes(tok)) score += 2;
      }

      const reuseNotes = fileNode.symbols
        .filter((s) => s.reuseTag)
        .map((s) => `${s.name}: ${s.reuseTag}`);

      const boundaries = fileNode.symbols
        .filter((s) => s.boundaryTag && !isFixturePath(s.boundaryTag))
        .map((s) => `${s.name}: ${s.boundaryTag}`);

      if (reuseNotes.length > 0 && score > 0) score += 2;

      return {
        file: fileNode.path,
        score,
        exports: fileNode.exports.slice(0, 10),
        reuseNotes,
        boundaries
      };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  const scoredModules = ranked.slice(0, limit);
  const entry = index.files[ranked[0]?.file];
  if (scoredModules.length > 1 && entry?.imports.length) {
    const paths = new Set(Object.keys(index.files));
    const imports = new Set(entry.imports.map(spec => resolveImport(entry.path, spec, paths)));
    const calls = new Set(entry.symbols.flatMap(symbol => symbol.calls));
    // Reserve one visible slot for the strongest intent-matching dependency
    // whose exported operation is actually called by the leading module.
    // Rank the called operation first. Whole-module relevance breaks ties.
    const intent = new Set(tokens);
    let implementation: ModuleRecommendation | undefined;
    let bestMatches = 0;
    for (const module of ranked) {
      if (module.file === entry.path || !imports.has(module.file)) continue;
      for (const name of index.files[module.file].exports) {
        if (!calls.has(name)) continue;
        const matches = tokenizeIntent(name).filter(word =>
          intent.has(word) || intent.has(word + "ing") ||
          (word.endsWith("e") && intent.has(word.slice(0, -1) + "ing"))
        ).length;
        if (matches > bestMatches) {
          bestMatches = matches;
          implementation = module;
        }
      }
    }
    const slot = Math.min(2, scoredModules.length - 1);
    if (implementation && !scoredModules.slice(0, slot + 1).includes(implementation)) {
      scoredModules.splice(slot, 0, implementation);
      const duplicate = scoredModules.indexOf(implementation, slot + 1);
      scoredModules.splice(duplicate < 0 ? scoredModules.length - 1 : duplicate, 1);
    }
  }

  return scoredModules;
}

export function recommendPath(
  projectRoot: string,
  index: GraphIndex,
  intent: string,
  limit = 5,
  guide = loadArchGuide(projectRoot)
): GuideRecommendation {
  const tokens = tokenizeIntent(intent);
  const scoredModules = rankModules(index, tokens, limit);
  const matchingPatterns = guide.patterns.filter((p) => {
    if (p.stale) return false;
    const blob = `${p.domain} ${p.entry} ${p.guidance} ${p.files.join(" ")}`.toLowerCase();
    return tokens.some((t) => blob.includes(t));
  });

  const stalePatternsWarning = guide.patterns
    .filter((p) => p.stale)
    .map((p) => `${p.id} (${p.staleReason ?? "desactualizado"})`);

  const relevantDocs = findRelevantDocs(projectRoot, [...tokens, ...matchingPatterns.flatMap((pattern) => tokenizeIntent(pattern.domain))]);

  const suggestedPath: string[] = [];
  if (matchingPatterns.length > 0) {
    suggestedPath.push(
      `Reutiliza primero los patrones registrados: ${matchingPatterns.map((p) => p.entry).join(", ")}.`
    );
  }
  if (scoredModules.length > 0) {
    suggestedPath.push(
      `Inspecciona antes de crear archivos nuevos: ${scoredModules.slice(0, 3).map((m) => m.file).join(", ")}.`
    );
  }
  if (relevantDocs.length > 0) {
    suggestedPath.push(`Respeta los contratos/reglas en: ${relevantDocs.join(", ")}.`);
  }
  if (suggestedPath.length === 0) {
    suggestedPath.push(
      "No se encontraron módulos cercanos por nombre; inspecciona la estructura raíz y registra el patrón con graph_register_pattern al finalizar."
    );
  }

  return {
    intent,
    projectRoot: path.resolve(projectRoot),
    recommendedModules: scoredModules,
    matchingPatterns,
    relevantDocs,
    suggestedPath,
    stalePatternsWarning
  };
}

export function registerPattern(
  projectRoot: string,
  domain: string,
  entry: string,
  guidance: string,
  files: string[] = []
): PatternEntry {
  const resolved = path.resolve(projectRoot);
  const id = `${domain.trim().toLowerCase()}:${entry.trim()}`;
  const record: PatternEntry = {
    id,
    domain: domain.trim(),
    entry: entry.trim(),
    guidance: guidance.trim(),
    files: [...new Set(files)],
    updatedAt: new Date().toISOString(),
    stale: false
  };

  updateArchGuide(resolved, guide => {
    const existingIdx = guide.patterns.findIndex((p) => p.id === id);
    if (existingIdx >= 0) guide.patterns[existingIdx] = record;
    else guide.patterns.push(record);
  });
  return record;
}
