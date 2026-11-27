import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ArchitectureProfile {
  architectures: string[];
  frameworks: string[];
  layers: string[];
  boundaries: string[];
  slices: string[];
  projects: { file: string; references: string[]; packages: string[] }[];
}

export function isManifest(file: string) {
  return /(?:\.csproj|(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod))$/i.test(file);
}

function readSmall(root: string, file: string) {
  try {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    return stat.isFile() && stat.size <= 256 * 1024 ? fs.readFileSync(full, "utf8") : "";
  } catch { return ""; }
}

export function detectArchitecture(root: string, knownFiles: string[], manifests: string[], signals: string[] = []): ArchitectureProfile {
  const inventory = knownFiles.join("\n");
  const hash = createHash("sha256").update("gentle-profile-v1\0").update(inventory).update("\0" + signals.join("|"));
  const contents = manifests.map(file => {
    const text = readSmall(root, file);
    hash.update("\0" + file + "\0" + text);
    return { file, text };
  });
  const fingerprint = hash.digest("hex");
  const location = ".gentle-graph/profile.json";
  try {
    const cached = JSON.parse(readSmall(root, location));
    if (cached.fingerprint === fingerprint && Array.isArray(cached.profile?.architectures)) return cached.profile;
  } catch { /* First scan or an older profile. */ }

  const profile: ArchitectureProfile = { architectures: [], frameworks: [], layers: [], boundaries: [], slices: [], projects: [] };
  const dirs = new Set<string>();
  const slices = new Set<string>();
  const folders = new Set<string>();
  for (const file of knownFiles) folders.add(file.slice(0, Math.max(0, file.lastIndexOf("/"))));
  for (const folder of folders) {
    for (const part of folder.toLowerCase().split(/[/.]/)) dirs.add(part);
    const slice = folder.match(/^(.*?(?:^|\/)(?:features|modules)\/[^/]+)/i);
    if (slice) slices.add(slice[1]);
  }
  profile.slices = [...slices].sort();
  const has = (...names: string[]) => names.some(n => dirs.has(n));
  const groups = [["Domain", "domain", "core"], ["Application", "application", "usecases", "ports"],
    ["Infrastructure", "infrastructure", "adapters", "persistence"], ["Presentation", "presentation", "ui", "api", "wpf"]];
  for (const [label, ...aliases] of groups) if (has(...aliases)) profile.layers.push(label);
  const arch = profile.architectures;
  if (profile.layers.includes("Domain") && profile.layers.includes("Application") && profile.layers.includes("Infrastructure")) {
    if (has("ports") && has("adapters")) arch.push("Hexagonal (Ports & Adapters)");
    else if (has("onion","domainservices","applicationservices")) arch.push("Onion Architecture");
    else arch.push("Clean Architecture");
    profile.boundaries.push("Domain sin dependencias hacia Infrastructure o Presentation");
  }
  if (profile.slices.some(s => /(?:^|\/)features\//i.test(s))) arch.push("Vertical Slice");
  if (profile.slices.some(s => /(?:^|\/)modules\//i.test(s))) arch.push("Modular Monolith");
  const packages = new Set<string>();
  for (const { file, text } of contents) {
    if (/\.csproj$/i.test(file)) {
      const xml = text.replace(/<!--[\s\S]*?-->/g, "");
      const refs = (kind: string) => [...xml.matchAll(new RegExp("<" + kind + "\\b[^>]*?\\bInclude\\s*=\\s*[\"']([^\"']+)[\"']", "gi"))].map(m => m[1]);
      const pkgs = refs("PackageReference");
      profile.projects.push({ file, packages: pkgs, references: refs("ProjectReference").map(ref =>
        path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.replaceAll("\\", "/")))) });
      for (const pkg of pkgs) packages.add(pkg);
    } else if (file.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(text);
        for (const key of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) packages.add(key);
      } catch { /* An unfinished manifest is common during edits. */ }
    } else if (/(?:pyproject\.toml|requirements\.txt)$/.test(file)) {
      for (const pkg of ["FastAPI", "Django"]) if (new RegExp("\\b" + pkg + "\\b", "i").test(text)) packages.add(pkg);
    } else if (file.endsWith("Cargo.toml") && /^\s*\[workspace\]/m.test(text)) arch.push("Rust Workspace");
  }
  for (const [pattern, label] of [
    [/^CommunityToolkit\.Mvvm$/i, "CommunityToolkit.Mvvm"], [/^Prism(?:\.|$)/i,"Prism"],
    [/^ReactiveUI(?:\.|$)/i,"ReactiveUI"], [/^Caliburn\.Micro/i,"Caliburn.Micro"],
    [/^MediatR(?:\.|$)/i,"MediatR"], [/EntityFrameworkCore/i,"EntityFrameworkCore"],
    [/^react$/,"React"], [/^next$/,"Next.js"], [/^@angular\/core$/,"Angular"],
    [/^@nestjs\/core$/,"NestJS"], [/^FastAPI$/i,"FastAPI"], [/^Django$/i,"Django"]
  ] as const) if ([...packages].some(pkg => pattern.test(pkg))) profile.frameworks.push(label);
  if (/\.xaml$/im.test(inventory)) {
    if (has("viewmodels")) arch.push("WPF MVVM");
    else if (has("presenters")) arch.push("WPF MVP");
    else if (/\.xaml\.cs$/im.test(inventory)) arch.push("WPF Code-Behind");
  }
  if (has("repositories") || /Repository\.cs$/im.test(inventory)) arch.push(/UnitOfWork\.cs$/im.test(inventory) ? "Repository + UnitOfWork" : "Repository");
  if (signals.includes("CQRS") || profile.frameworks.includes("MediatR") || (has("commands","queries","features") && /Handler\.cs$/im.test(inventory))) arch.push("CQRS");
  if (signals.includes("DI") || /ServiceCollection|DependencyInjection|ServiceRegistration/i.test(inventory) || [...packages].some(p => p.startsWith("Microsoft.Extensions.DependencyInjection"))) arch.push(".NET DI");
  if (has("controllers") && has("services")) arch.push(profile.frameworks.includes("NestJS") ? "NestJS Modules" : "MVC");
  if (["pages","widgets","features","entities","shared"].every(d => dirs.has(d))) arch.push("Feature-Sliced Design");
  if (has("components") && has("hooks","stores")) arch.push("Component UI");
  if (has("routers") && has("schemas") && profile.frameworks.includes("FastAPI")) arch.push("FastAPI routers");
  if (profile.frameworks.includes("Django") && /(?:^|\/)apps\.py$/m.test(inventory)) arch.push("Django apps");
  if (has("cmd") && has("internal","pkg")) arch.push("Go standard layout");
  if (has("crates")) arch.push("Rust Workspace");
  profile.architectures = [...new Set(arch)];
  const dest = path.join(root, location);
  const tmp = dest + "." + randomUUID() + ".tmp";
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint, profile }));
    fs.renameSync(tmp, dest);
  } catch { /* Read-only checkouts still return a profile. */ }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ } }
  return profile;
}
