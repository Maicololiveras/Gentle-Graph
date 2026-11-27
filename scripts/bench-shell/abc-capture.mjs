import fs from "node:fs";
import path from "node:path";

export default function capture(pi) {
  const dir = process.env.GENTLE_ABC_EVIDENCE;
  const probe = process.env.GENTLE_ABC_PROBE === "1";
  const save = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
  const snapshot = ctx => ({
    active: pi.getActiveTools(),
    registered: pi.getAllTools().map(t => t.name),
    model: ctx.model && ctx.model.provider + "/" + ctx.model.id,
    thinking: pi.getThinkingLevel()
  });
  if (probe) {
    pi.on("session_start", (_event, ctx) => {
      // MCP connects asynchronously. No prompt is sent to this RPC session.
      const deadline = Date.now() + 45000;
      const timer = setInterval(async () => {
        const state = snapshot(ctx);
        if (process.env.GENTLE_ABC_ARM === "B" &&
            !state.active.some(n => n.startsWith("mcp__codegraph__")) && Date.now() < deadline) return;
        clearInterval(timer);
        try {
          state.available = (await ctx.modelRegistry.getAvailable()).some(m => m.provider + "/" + m.id === state.model);
          save("preflight-tools.json", state);
        } finally { ctx.shutdown(); }
      }, 200);
    });
    return;
  }
  pi.on("before_agent_start", (_event, ctx) => save("active-tools.json", snapshot(ctx)));
  pi.on("tool_execution_start", e => {
    const row = {time:Date.now(), id:e.toolCallId, parent:e.parentToolCallId, tool:e.toolName};
    if (["bash","powershell"].includes(row.tool)) row.search = /\b(?:rg|grep|findstr|Select-String)\b/i.test(e.args?.command ?? "");
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(row) + "\n");
  });
}
