import type { SourceSite } from "../types.ts";
import path from "node:path";
import { findBraceBlockEnd, sourceFile } from "./lexer-core.ts";
import type { LanguageAdapter } from "./types.ts";

export const generatedCSharp = /\.(?:g(?:\.i)?|designer|AssemblyInfo)\.cs$/i;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const clrType = /\b(?:class|interface|record(?:\s+(?:class|struct))?|struct|enum)\s+(\w+)(?:<[^>]*>)?/;
const hasAccess = (line: string) => /\b(?:public|internal)\b/.test(line);

// Both regex passes visit offsets in ascending order. Count newlines once.
function lineLocator(text: string) {
  let cursor = 0, line = 1;
  return (offset: number) => {
    while (cursor < offset) if (text.charCodeAt(cursor++) === 10) line++;
    return line;
  };
}

export const csharp: LanguageAdapter = {
  id: "csharp", extensions: [".cs"],
  isTestFile: f => /Tests?\.cs$|(?:^|\/)[^/]*\.Tests\//i.test(f),
  parse(_root, file, content) {
    const { clean, result, add } = sourceFile(file, content, "csharp");
    let owner = "", endOwner = -1, endMember = -1;
    let attributes = "";
    clean.forEach((line, i) => {
      const using = line.match(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/);
      if (using) result.imports.push(using[1]);
      const ns = line.match(/\bnamespace\s+([\w.]+)/);
      if (ns) result.namespace = ns[1];
      for (const reg of line.matchAll(/\b(AddScoped|AddTransient|AddSingleton)\s*<([^>]+)>\s*\(/g)) {
        const deps = reg[2].split(",").map(x => x.trim().split(".").at(-1)!);
        add(reg[1] + "<" + reg[2] + ">", "method", i, i, false, deps);
      }
      const type = line.match(clrType);
      if (type) {
        owner = type[1];
        endOwner = findBraceBlockEnd(clean, i, clean.length);
        endMember = -1;
        attributes = "";
        const tail = line.slice(type.index! + type[0].length);
        const clause = (tail.includes("{") ? tail : [tail, ...clean.slice(i + 1, Math.min(i + 24, endOwner + 1))].join(" ")).split(/[;{]/)[0].split(/\bwhere\b/)[0];
        const bases = clause.split(":")[1] ?? "";
        const contracts = [...bases.matchAll(/(?:^|,)\s*(?:[\w.]+\.)?(\w+)(?:<[^>]*>)?/g)].map(m => m[1]);
        const argumentsUsed = [...bases.matchAll(/<([^>]+)>/g)].flatMap(m => m[1].match(/\b[A-Z]\w*/g) ?? []);
        const kind = type[0].split(/\s/)[0] as "class" | "struct" | "enum" | "record" | "interface";
        const sym = add(owner, kind, i, endOwner, hasAccess(line), [...contracts, ...argumentsUsed]);
        if (contracts.length) sym.contracts = contracts;
        return;
      }
      if (i > endOwner || i <= endMember || !owner) return;
      const declaration = line.replace(/^\s*(?:\[[^\]]+\]\s*)+/, match => { attributes += match; return ""; }).trim();
      if (!declaration || declaration === "{") return;
      const relay = /\bRelayCommand(?:Attribute)?\b/.test(attributes);
      const observable = /\bObservableProperty(?:Attribute)?\b/.test(attributes);
      attributes = "";
      let signature = declaration;
      if (signature.includes("(") && !signature.includes(")")) signature += " " + clean.slice(i + 1, i + 24).join(" ").split(")")[0] + ")";
      const method = signature.match(/^(?:(?:public|private|internal|protected|static|virtual|override|abstract|async|partial|sealed|new|extern)\s+)*(?:[\w.<>?,[\]\s]+\s+)?(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)/);
      if (method) {
        const [, name, parameters] = method;
        endMember = findBraceBlockEnd(clean, i);
        const sym = add(owner + "." + name, "method", i, endMember, hasAccess(line));
        if (name === owner) {
          for (const p of parameters.split(",")) {
            const dep = p.trim().match(/(?:^|\.)([A-Z]\w*)(?:<[^>]+>)?\s+\w+/);
            if (dep) sym.calls.push(dep[1]);
          }
        }
        if (relay) add(name.replace(/Async$/, "") + "Command", "property", i, i, true, [sym.name]);
        return;
      }
      const event = declaration.match(/\bevent\s+[\w.<>?,]+\s+(\w+)/);
      if (event) { add(event[1], "event", i, i, hasAccess(line), []); return; }
      const prop = declaration.match(/^(?:(?:public|private|internal|protected|static|virtual|override|partial|readonly|required)\s+)*[\w.<>?,[\]]+\s+(\w+)\s*(?:[{=;]|$)/);
      if (prop && (observable || hasAccess(declaration))) {
        const name = observable ? capital(prop[1].replace(/^_+/, "") || prop[1]) : prop[1];
        add(name, "property", i, i, true, []);
      }
    });
    const code = clean.join("\n");
    const properties = new Map(result.symbols.filter(s => s.kind === "property").map(s => [s.name, s]));
    // Method groups passed to Prism are references even without call parentheses.
    const assignment = /\b(\w+)\s*=\s*new\s+(?:[\w.]+\.)?DelegateCommand(?:\s*<[^>]+>)?\s*\(\s*(?:this\.)?(\w+)\s*(?:,\s*(?:this\.)?(\w+)\s*)?\)/g;
    const registrationLine = lineLocator(code);
    for (const match of code.matchAll(assignment)) {
      const [, property, execute, canExecute] = match;
      const command = properties.get(property);
      if (!command) continue;
      for (const [role, name] of [["Execute", execute], ["CanExecute", canExecute]] as const) {
        if (!name) continue;
        const candidates = result.symbols.filter(s => s.kind === "method" && s.name.endsWith("." + name));
        const ref = candidates.length === 1 ? candidates[0].name : name;
        if (!command.calls.includes(ref)) command.calls.push(ref);
        (command.sites ??= []).push({ target: ref, role, line: registrationLine(match.index!) });
      }
    }
    const testFile = csharp.isTestFile(file);
    for (const method of result.symbols.filter(s => s.kind === "method")) {
      const owner = method.name.split(".")[0];
      const types = new Map<string, string>();
      const names = new Set(method.calls);
      const verified = new Set<string>();
      for (let n = method.line - 1; n < method.endLine; n++) {
        const line = clean[n];
        for (const m of line.matchAll(/\b([A-Z]\w*)(?:<[^<>;]+>)?\s+(\w+)\s*(?=[,)=;])/g)) types.set(m[2], m[1]);
        for (const m of line.matchAll(/\bvar\s+(\w+)\s*=\s*new\s+([A-Z]\w*)/g)) types.set(m[1], m[2]);
        for (const m of line.matchAll(/\b(\w+)\s*(?:<[^<>;]+>)?\s*\(/g)) {
          if (!names.has(m[1])) continue;
          const before = line.slice(0, m.index).trimEnd();
          const receiver = before.match(/(?:^|[^.\w?])(\w+)\s*\??\.\s*$/)?.[1];
          const type = before.endsWith(".")
            ? receiver === "this" ? owner : receiver && (types.get(receiver) ?? (/^[A-Z]/.test(receiver) ? receiver : undefined))
            : owner;
          if (!type) continue;
          const qualified = type + "." + m[1];
          verified.add(qualified);
          if (testFile) (method.sites ??= []).push({ role: "Test call", target: m[1], qualified, line: n + 1 });
        }
      }
      method.qualifiedCalls = [...verified];
    }
    if (/\.xaml\.cs$/i.test(file)) {
      const types = new Set<string>();
      for (const match of code.matchAll(/\bDataContext\s*=\s*new\s+(?:[\w.]+\.)?(\w+)\s*\(/g)) types.add(match[1]);
      if (types.size) {
        result.dataContexts = [...types];
        const view = result.symbols.find(s => s.kind === "class" && s.name.toLowerCase() === path.basename(file, ".xaml.cs").toLowerCase())
          ?? result.symbols.find(s => s.kind === "class");
        if (view) view.calls.push(...types);
      }
    }
    return result;
  }
};

export const xaml: LanguageAdapter = {
  id: "xaml", extensions: [".xaml"], isTestFile: () => false,
  resolveRelativeImport(file, spec, files) {
    const target = path.posix.join(path.posix.dirname(file), spec);
    return spec.startsWith("./") && files.has(target) ? target : null;
  },
  parse(_root, file, content) {
    const { result, add } = sourceFile(file, content, "xaml");
    const xml = content.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\r\n]/g, " "));
    const cls = xml.match(/\bx:Class\s*=\s*["']([\w.]+)["']/);
    const name = cls?.[1].split(".").at(-1) ?? path.posix.basename(file, ".xaml");
    const calls = new Set<string>();
    const sites: SourceSite[] = [];
    const bindingLine = lineLocator(xml);
    const prefixes = new Set<string>();
    for (const m of xml.matchAll(/\bxmlns:([\w-]+)\s*=\s*["']clr-namespace:([^;"']+)/g)) {
      prefixes.add(m[1]);
      result.imports.push(m[2]);
    }
    for (const m of xml.matchAll(/\b([\w-]+):(\w+)/g)) if (prefixes.has(m[1])) calls.add(m[2]);
    for (const m of xml.matchAll(/\{\s*(?:Binding\s+(?:Path\s*=\s*)?|(?:StaticResource|DynamicResource)\s+)([\w.]+)(?=\s*[,}])/g)) {
      const end = xml.indexOf("}", m.index! + m[0].length);
      const text = xml.slice(m.index!, end < 0 ? m.index! + m[0].length : Math.min(end + 1, m.index! + 160)).replace(/\s+/g, " ");
      for (const part of m[1].split(".")) {
        calls.add(part);
        if (/^\{\s*Binding\b/.test(m[0])) sites.push({ role: "Binding", target: part, line: bindingLine(m.index!), text });
      }
    }
    result.imports.push("./" + path.posix.basename(file) + ".cs");
    const line = xml.slice(0, cls?.index ?? 0).split("\n").length - 1;
    const view = add(name, "class", line, xml.split("\n").length - 1, true, [...calls]);
    if (sites.length) view.sites = sites;
    return result;
  }
};
