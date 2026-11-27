import type { GuideRecommendation, ImpactResult, InspectResult, PatternEntry, SymbolRef } from "./types.ts";

function compact(lines: string[], limit: number): string {
  const text = lines.filter(Boolean).join("\n");
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + "…";
}

function field(label: string, values: string[]): string {
  return values.length ? label + ": " + values.join(", ") : "";
}

function refs(values: SymbolRef[]): string[] {
  return values.map(r => r.file ? `${r.file}:${r.line}#${r.name}` : r.name);
}

export function formatGuide(g: GuideRecommendation): string {
  const guide = compact([
    ...g.recommendedModules.slice(0,3).map(m=>[m.file,m.coordinate,m.caller && "<- "+m.caller,m.associatedTest && "test "+m.associatedTest].filter(Boolean).join(" ")),
    ...g.matchingPatterns.map(p => `Reuse ${p.entry} — ${p.guidance}`),
    field("Docs", g.relevantDocs),
    g.architecture ? "ARCH: " + g.architecture : "",
    field("BOUNDARIES", g.boundaries ?? []),
    g.slice ?? "",
    ...g.recommendedModules.flatMap(m => [...m.reuseNotes, ...m.boundaries]),
    field("Stale", g.stalePatternsWarning),
    ...(!g.matchingPatterns.length && !g.recommendedModules.length ? g.suggestedPath : [])
  ], g.subgraph?.length ? 780 : 1199);
  if (!g.subgraph?.length) return guide;
  const blocks = g.subgraph.map(m => compact([
    m.symbol.id + ":" + m.symbol.line,
    ...[["Calls", m.callees], ["Called by", m.callers], ["Implemented by", m.implementations ?? []]].map(([label, items]: [string, SymbolRef[]]) =>
      field(label, refs(items).slice(0, 3)).slice(0, 115)),
    m.snippet.split("\n").slice(0,10).join("\n")
  ], 730));
  return compact([guide, ...blocks], 3000);
}

export function formatInspect(matches: InspectResult[]): string {
  if (!matches.length) return "No matching symbols.";
  if (matches[0].alternatives) return compact(["Ambiguous symbol. Inspect one file#symbol:", ...matches[0].alternatives], 3000);
  return compact(matches.flatMap(m => [
    `${m.symbol.file}:${m.symbol.line}  ${m.symbol.signature}`,
    field("Implemented by", refs(m.implementations ?? [])),
    ...(m.evidence ?? []).map(s => s.role + " " + s.file + ":" + s.line + " → " + [...(s.via ?? []), s.text ?? s.qualified ?? s.target].join(" → ")),
    field("Calls", refs(m.callees)), field("Called by", refs(m.callers)),
    // The signature and location are already in the header.
    m.snippet.split("\n").filter((line,i)=>i!==0 || line.replace(/^\d+:\s*/, "").trim()!==m.symbol.signature).join("\n")
  ]), 3000);
}

export function formatImpact(i: ImpactResult): string {
  if (i.alternatives) return compact(["Ambiguous symbol. Use one file#symbol:", ...i.alternatives], 2000);
  return compact([i.partial ? "Partial impact (time budget reached)" : "", i.target, field("Direct", refs(i.directCallers)),
    field("Test dependencies (static)", i.dependencyTests ?? i.relatedTests),
    field("Test candidates (name only)", i.namedTests ?? []), field("Files", i.affectedFiles),
    field("Indirect", refs(i.transitiveCallers)),
    field("Patterns", i.affectedPatterns.map(p => p.entry))], 2000);
}

export function formatPattern(p: PatternEntry): string {
  return compact([`Saved ${p.domain}: ${p.entry}`, p.guidance, field("Files", p.files)], 1000);
}
