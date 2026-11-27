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
  return /(?:\.csproj|(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile|Package\.swift|pubspec\.yaml))$/i.test(file);
}

function readSmall(root: string, file: string) {
  try {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    return stat.isFile() && stat.size <= 256 * 1024 ? fs.readFileSync(full, "utf8") : "";
  } catch { return ""; }
}

export interface ArchitectureCache {fingerprint?:string; profile?:ArchitectureProfile}
export function detectArchitecture(root: string, knownFiles: string[], manifests: string[], signals: string[] = [], session?:ArchitectureCache): ArchitectureProfile {
  const inventory = knownFiles.join("\n");
  const hash = createHash("sha256").update("gentle-profile-v2\0").update(inventory).update("\0" + signals.join("|"));
  const contents = manifests.map(file => {
    const text = readSmall(root, file);
    hash.update("\0" + file + "\0" + text);
    return { file, text };
  });
  const fingerprint = hash.digest("hex");
  const location = ".gentle-graph/profile.json";
  if(session?.fingerprint===fingerprint && session.profile)return session.profile;
  if(!session)try {
    const cached = JSON.parse(readSmall(root, location));
    if (cached.fingerprint === fingerprint && Array.isArray(cached.profile?.architectures)) return cached.profile;
  } catch { /* First scan or an older profile. */ }

  const profile: ArchitectureProfile = { architectures: [], frameworks: [], layers: [], boundaries: [], slices: [], projects: [] };
  const dirs = new Set<string>();
  const slices = new Set<string>();
  const folders = new Set<string>();
  let previousFolder = "";
  for (const file of knownFiles) {
    const end = file.lastIndexOf("/");
    if (end < 0 || (end === previousFolder.length && file.startsWith(previousFolder))) continue;
    previousFolder = file.slice(0, end);
    folders.add(previousFolder);
  }
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
    if (/(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(file) && /org\.springframework\.boot|spring-boot-starter/.test(text)) packages.add("Spring Boot");
    if (/build\.gradle(?:\.kts)?$/.test(file)) {
      if (/io\.ktor/.test(text)) packages.add("Ktor");
      if (/com\.android\.(?:application|library)|androidx\.lifecycle/.test(text)) packages.add("Android");
    }
    if (file.endsWith("Package.swift") && /\bSwiftUI\b/.test(text)) packages.add("SwiftUI");
    if (file.endsWith("pubspec.yaml")) {
      for (const [pattern,name] of [[/^\s+flutter\s*:/m,"Flutter"],[/^\s+(?:flutter_)?bloc\s*:/m,"BLoC"],[/^\s+(?:(?:flutter|hooks)_)?riverpod\s*:/m,"Riverpod"]] as const)
        if (pattern.test(text)) packages.add(name);
    }
    if (file.endsWith("composer.json")) {
      try {
        const manifest=JSON.parse(text);
        for(const name of Object.keys({...manifest.require,...manifest["require-dev"]})) {
          if(name==="laravel/framework") packages.add("Laravel");
          if(name==="symfony/framework-bundle") packages.add("Symfony");
        }
      } catch { /* An unfinished manifest can still be edited. */ }
    }
    if (file.endsWith("Gemfile") && /^\s*gem\s+["']rails["']/m.test(text)) packages.add("Rails");
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
  for (const name of ["Spring Boot","Laravel","Symfony","Rails","Ktor","Android","SwiftUI","Flutter","BLoC","Riverpod"]) if(packages.has(name)) profile.frameworks.push(name);
  if (signals.includes("SwiftUI") && !profile.frameworks.includes("SwiftUI")) profile.frameworks.push("SwiftUI");
  if (profile.frameworks.includes("SwiftUI") && /ViewModel\.swift$/im.test(inventory)) arch.push("SwiftUI MVVM");
  if (packages.has("Android") && /ViewModel\.kt$/im.test(inventory)) arch.push("Android MVVM");
  if (signals.includes("Spring Boot") && !profile.frameworks.includes("Spring Boot")) profile.frameworks.push("Spring Boot");
  if (/(?:^|\/)routes\/(?:[^\n]*\/)?\+(?:page(?:\.server\.ts|\.svelte)|layout\.svelte)$/m.test(inventory)) arch.push("SvelteKit");
  if (/\.xaml$/im.test(inventory)) {
    if (has("viewmodel","viewmodels") || signals.includes("MVVM") || /(?:VM|ViewModel)\.cs$/m.test(inventory)) arch.push("WPF MVVM");
    else if (has("presenters")) arch.push("WPF MVP");
    else if (/\.xaml\.cs$/im.test(inventory)) arch.push("WPF Code-Behind");
  }
  if (has("repositories") || /Repository\.cs$/im.test(inventory)) arch.push(/UnitOfWork\.cs$/im.test(inventory) ? "Repository + UnitOfWork" : "Repository");
  if (signals.includes("CQRS") || profile.frameworks.includes("MediatR") || (has("commands","queries","features") && /Handler\.cs$/im.test(inventory))) arch.push("CQRS");
  if (signals.includes("DI") || /ServiceCollection|DependencyInjection|ServiceRegistration/i.test(inventory) || [...packages].some(p => p.startsWith("Microsoft.Extensions.DependencyInjection"))) arch.push(".NET DI");
  const webEvidence = profile.frameworks.includes("NestJS") || contents.some(m => /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore\.Mvc/i.test(m.text));
  if (has("controllers") && has("services") && (!/\.xaml$/im.test(inventory) || webEvidence)) arch.push(profile.frameworks.includes("NestJS") ? "NestJS Modules" : "MVC");
  if (["pages","widgets","features","entities","shared"].every(d => dirs.has(d))) arch.push("Feature-Sliced Design");
  if (has("components") && has("hooks","stores")) arch.push("Component UI");
  if (has("routers") && has("schemas") && profile.frameworks.includes("FastAPI")) arch.push("FastAPI routers");
  if (profile.frameworks.includes("Django") && /(?:^|\/)apps\.py$/m.test(inventory)) arch.push("Django apps");
  if (has("cmd") && has("internal","pkg")) arch.push("Go standard layout");
  if (has("crates")) arch.push("Rust Workspace");
  profile.architectures = [...new Set(arch)];
  // A host worker already has one lifetime and root. Keep the derived profile
  // there, avoiding a second atomic disk write alongside the durable graph.
  if(session){session.fingerprint=fingerprint;session.profile=profile;return profile;}
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
