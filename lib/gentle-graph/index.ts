import path from "node:path";
import {registerPattern} from "./arch-guide.ts";
import {syncGraphIndex} from "./indexer.ts";
import {loadArchGuide} from "./store.ts";
import type {PatternEntry, GraphStatus} from "./types.ts";
export {graphGuide} from "./query-guide.ts";
export {graphInspect} from "./query-inspect.ts";
export {graphImpact} from "./query-impact.ts";

export function graphRegisterPattern(
  domain: string,
  entry: string,
  guidance: string,
  files: string[] = [],
  projectRoot = process.cwd()
): PatternEntry {
  return registerPattern(path.resolve(projectRoot), domain, entry, guidance, files);
}

export function graphStatus(projectRoot = process.cwd()): GraphStatus {
  const resolved = path.resolve(projectRoot);
  const { index, stats } = syncGraphIndex(resolved, true);
  const guide = loadArchGuide(resolved);
  const totalSymbols = Object.values(index.files).reduce((acc, f) => acc + f.symbols.length, 0);
  return {
    projectRoot: resolved,
    indexedFiles: Object.keys(index.files).length,
    totalSymbols,
    registeredPatterns: guide.patterns.length,
    stalePatterns: stats.stalePatterns,
    updatedAt: index.updatedAt
  };
}
