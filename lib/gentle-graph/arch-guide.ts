import fs from "node:fs";
import path from "node:path";
import { loadArchGuide, saveArchGuide } from "./store.ts";
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
  return [...new Set(raw)];
}

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

  return candidates
    .filter((rel) => {
      const lower = rel.toLowerCase();
      return lower === "agents.md" || tokens.some((t) => lower.includes(t));
    })
    .slice(0, 6);
}

export function recommendPath(
  projectRoot: string,
  index: GraphIndex,
  intent: string,
  limit = 5
): GuideRecommendation {
  const tokens = tokenizeIntent(intent);
  const guide = loadArchGuide(projectRoot);

  const scoredModules: ModuleRecommendation[] = Object.values(index.files)
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
        .filter((s) => s.boundaryTag)
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
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

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
  const guide = loadArchGuide(resolved);
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

  const existingIdx = guide.patterns.findIndex((p) => p.id === id);
  if (existingIdx >= 0) {
    guide.patterns[existingIdx] = record;
  } else {
    guide.patterns.push(record);
  }

  saveArchGuide(resolved, guide);
  return record;
}
