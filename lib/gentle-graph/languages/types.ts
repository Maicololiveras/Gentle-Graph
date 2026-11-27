import type { CodeSymbol } from "../types.ts";

export interface ParsedFile {
  language: string;
  imports: string[];
  exports: string[];
  symbols: CodeSymbol[];
  namespace?: string;
  dataContexts?: string[];
}

export interface LanguageAdapter {
  id: string;
  extensions: string[];
  parse(projectRoot: string, relPath: string, content: string): ParsedFile;
  isTestFile(relPath: string): boolean;
  resolveRelativeImport?(fromFile: string, specifier: string, existingFiles: Set<string>): string | null;
}
