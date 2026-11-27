import fs from "node:fs";
import path from "node:path";

export function sessionMetrics(sessions) {
  const totals = { input:0, output:0, cacheRead:0, cacheWrite:0, costUSD:0 };
  const models = new Set();
  let failedTurn = false;
  let searchCalls = 0;
  let turns = 0, measuredTurns = 0, tokens = 0;
  const calls = {};
  for (const file of fs.readdirSync(sessions,{recursive:true}).filter(f => f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(sessions,file),"utf8").split(/\r?\n/).filter(Boolean)) {
      const msg = JSON.parse(line).message;
      if (msg?.role !== "assistant") continue;
      turns++;
      if (msg.model) models.add([msg.provider,msg.model].filter(Boolean).join("/"));
      if (["error","aborted"].includes(msg.stopReason)) failedTurn = true;
      for (const key of Object.keys(totals)) {
        const value = key === "costUSD" ? msg.usage?.cost?.total : msg.usage?.[key];
        if (!Number.isFinite(value) || totals[key] === null) totals[key] = null;
        else totals[key] += value;
      }
      if (Number.isFinite(msg.usage?.totalTokens) && msg.usage.totalTokens > 0) { measuredTurns++; tokens += msg.usage.totalTokens; }
      for (const item of Array.isArray(msg.content) ? msg.content : []) {
        if (item.type !== "toolCall") continue;
        calls[item.name] = (calls[item.name] ?? 0)+1;
        if (["grep","rg","find"].includes(item.name) || (item.name === "bash" && /\b(?:rg|grep|findstr|Select-String)\b/i.test(item.arguments?.command ?? ""))) searchCalls++;
      }
    }
  }
  return {totals, models, failedTurn, searchCalls, turns, measuredTurns, tokens, calls};
}
