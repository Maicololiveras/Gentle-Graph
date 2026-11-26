#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * Fase 4: Auditoría de adopción real de Gentle Graph sobre sesiones JSONL de gentle-agents.
 * Uso: node scripts/audit-gentle-graph.mjs [ruta-a-sessions-dir]
 */
const sessionsDir = path.resolve(process.argv[2] || "gentle-agents/sessions");

if (!fs.existsSync(sessionsDir)) {
  console.error(`No se encontró el directorio de sesiones: ${sessionsDir}`);
  process.exit(1);
}

const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
let totalSessions = 0;
let sessionsWithGraphAvailable = 0;
let sessionsUsingGraph = 0;
let totalGraphCalls = 0;
let totalGrepCalls = 0;

for (const file of files) {
  totalSessions++;
  const lines = fs.readFileSync(path.join(sessionsDir, file), "utf8").split(/\r?\n/).filter(Boolean);
  let hasGraphTool = false;
  let usedGraph = false;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const message = record.message ?? record;
    const toolsAdded = message.toolsAdded ?? record.toolsAdded;
    if (Array.isArray(toolsAdded) && toolsAdded.some((tool) => String(tool?.name ?? tool).startsWith("graph_"))) {
      hasGraphTool = true;
    }
    const calls = message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "toolCall")
      : record.toolCall ? [record.toolCall] : [];
    for (const call of calls) {
      if (call.name?.startsWith("graph_")) {
        usedGraph = true;
        totalGraphCalls++;
      } else if (["grep", "rg"].includes(call.name) || (call.name === "bash" && /\b(rg|grep)\b/.test(call.arguments?.command ?? call.args?.command ?? ""))) {
        totalGrepCalls++;
      }
    }
  }

  if (hasGraphTool || usedGraph) sessionsWithGraphAvailable++;
  if (usedGraph) sessionsUsingGraph++;
}

const availabilityPct = totalSessions ? ((sessionsWithGraphAvailable / totalSessions) * 100).toFixed(1) : "0.0";
const adoptionPct = sessionsWithGraphAvailable ? ((sessionsUsingGraph / sessionsWithGraphAvailable) * 100).toFixed(1) : "0.0";

console.log(JSON.stringify({
  sessionsDir,
  totalSessions,
  sessionsWithGraphAvailable,
  availabilityPct: `${availabilityPct}%`,
  sessionsUsingGraph,
  adoptionPct: `${adoptionPct}%`,
  totalGraphCalls,
  totalGrepCalls
}, null, 2));
