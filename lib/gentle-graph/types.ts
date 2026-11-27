export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "method"
  | "struct"
  | "trait" | "record" | "enum" | "property" | "event";

export interface SourceSite {
  qualified?: string;
  target: string;
  role: "Execute" | "CanExecute" | "Binding" | "Test call";
  line: number;
  text?: string;
}

export interface CodeSymbol {
  sites?: SourceSite[];
  qualifiedCalls?: string[];
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  endLine: number;
  exported: boolean;
  signature: string;
  calls: string[];
  contracts?: string[];
  reuseTag?: string;
  domainTag?: string;
  boundaryTag?: string;
}

export interface FileNode {
  namespace?: string;
  dataContexts?: string[];
  preview?: boolean;
  path: string;
  language: string;
  mtimeMs: number;
  sha256: string;
  imports: string[];
  exports: string[];
  symbols: CodeSymbol[];
}

export interface GraphIndex {
  version: number;
  projectRoot: string;
  updatedAt: string;
  files: Record<string, FileNode>;
}

export interface PatternEntry {
  id: string;
  domain: string;
  entry: string;
  guidance: string;
  files: string[];
  updatedAt: string;
  stale?: boolean;
  staleReason?: string;
}

export interface ArchGuideStore {
  rules?: string[];
  boundaries?: string[];
  version: number;
  patterns: PatternEntry[];
}

export interface SyncStats {
  scanned: number;
  updated: number;
  removed: number;
  durationMs: number;
  stalePatterns: number;
}

export interface SymbolRef {
  name: string;
  file?: string;
  line?: number;
  hop: number;
}

export interface InspectResult {
  implementations?: SymbolRef[];
  alternatives?: string[];
  evidence?: (SourceSite & { file: string; via?: string[] })[];
  symbol: CodeSymbol;
  snippet: string;
  callees: SymbolRef[];
  callers: SymbolRef[];
}

export interface ImpactResult {
  alternatives?: string[];
  dependencyTests?: string[];
  namedTests?: string[];
  target: string;
  directCallers: SymbolRef[];
  transitiveCallers: SymbolRef[];
  affectedFiles: string[];
  relatedTests: string[];
  affectedPatterns: PatternEntry[];
}

export interface ModuleRecommendation {
  file: string;
  score: number;
  exports: string[];
  reuseNotes: string[];
  boundaries: string[];
}

export interface GuideRecommendation {
  architecture?: string;
  boundaries?: string[];
  slice?: string;
  intent: string;
  projectRoot: string;
  recommendedModules: ModuleRecommendation[];
  matchingPatterns: PatternEntry[];
  relevantDocs: string[];
  suggestedPath: string[];
  stalePatternsWarning: string[];
}

export interface GraphStatus {
  projectRoot: string;
  indexedFiles: number;
  totalSymbols: number;
  registeredPatterns: number;
  stalePatterns: number;
  updatedAt: string;
}
