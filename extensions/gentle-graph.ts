import {sessionQueryDetails,closeQuerySessions,type QueryReply} from "../lib/gentle-graph/query-session.ts";
import {queryEvent,telemetryWriter,type GraphTool} from "../lib/gentle-graph/telemetry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import {
	graphRegisterPattern,
} from "../lib/gentle-graph/index.ts";
import {clearGitSession} from "../lib/gentle-graph/git-scope.ts";
import { clearMemoryCache } from "../lib/gentle-graph/store.ts";

import { formatPattern } from "../lib/gentle-graph/format.ts";

const GRAPH_PROMPT_HINT = "Read graph_guide ranges with offset/limit first.";

const CODEMODE_HINT = "Read graph_guide ranges with offset/limit. In codemode call tools.graph_inspect or tools.graph_impact.";

function resolveRoot(explicitRoot?: string, ctxCwd?: string): string {
	return explicitRoot || ctxCwd || process.env.GENTLE_WORKTREE_ROOT || process.cwd();
}

const GuideParams = Type.Object({
	intent: Type.String(),
	includeSnippets: Type.Optional(Type.Boolean()),
	projectRoot: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

const InspectParams = Type.Object({
	symbol: Type.String(),
	depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
	projectRoot: Type.Optional(Type.String()),
});

const ImpactParams = Type.Object({
	target: Type.String(),
	projectRoot: Type.Optional(Type.String()),
});

const RegisterPatternParams = Type.Object({
	domain: Type.String(),
	entry: Type.String(),
	guidance: Type.String(),
	files: Type.Optional(Type.Array(Type.String())),
	projectRoot: Type.Optional(Type.String()),
});

export function graphLoadout(name:string){
  return {prepareLoadout(loadout:{declared:readonly (string|{name:string})[]}){
    const names=loadout.declared.map(tool=>typeof tool==="string"?tool:tool.name);
    if(names.includes("codemode") && names.includes(name))return {hiddenDeclarations:[name]};
  }};
}

export default function gentleGraphExtension(pi: ExtensionAPI) {
  const writer = telemetryWriter();
  const routes = new Map<string, {name:string; via:boolean | null}>();
  pi.on("tool_execution_start", event => {
    const parent = event.parentToolCallId ? routes.get(event.parentToolCallId) : undefined;
    const via = event.parentToolCallId ? (parent ? parent.name === "codemode" || parent.via : null) : false;
    routes.set(event.toolCallId,{name:event.toolName,via});
  });
  pi.on("tool_execution_end", event => { routes.delete(event.toolCallId); });

  async function timedQuery(id:string, tool:GraphTool, root:string, sessionId:string | undefined, query:() => Promise<QueryReply>) {
    const start = performance.now();
    const via = routes.get(id)?.via ?? null;
    try {
      const reply = await query();
      const event = queryEvent(tool,id,root,sessionId,via,performance.now()-start,reply);
      writer.record(event);
      return {content:[{type:"text" as const,text:reply.text}],details:{gentleGraph:event}};
    } catch (error) {
      writer.record(queryEvent(tool,id,root,sessionId,via,performance.now()-start,undefined,
        error instanceof Error ? error.name : "Error"));
      throw error;
    }
  }

	pi.registerTool({
		name: "graph_guide",
		label: "Gentle Graph guide",
		description: "Find reusable modules, patterns and contracts.",
		parameters: GuideParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { intent, projectRoot, limit, includeSnippets } = params as {
				intent: string;
				projectRoot?: string;
				limit?: number;
				includeSnippets?: boolean;
			};
			const root = resolveRoot(projectRoot,ctx?.cwd);
			return timedQuery(_toolCallId, "graph_guide", root, ctx?.sessionManager?.getSessionId?.(), () => sessionQueryDetails({kind:"guide",term:intent,root, limit, includeSnippets}));
		},
	});

	pi.registerTool({
		name: "graph_inspect",
        ...graphLoadout("graph_inspect"),
		label: "Gentle Graph inspect",
		description: "Inspect a symbol and its callers and callees.",
		parameters: InspectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { symbol, depth, projectRoot } = params as {
				symbol: string;
				depth?: number;
				projectRoot?: string;
			};
			const root = resolveRoot(projectRoot,ctx?.cwd);
			return timedQuery(_toolCallId, "graph_inspect", root, ctx?.sessionManager?.getSessionId?.(), () => sessionQueryDetails({kind:"inspect",term:symbol,root, depth}));
		},
	});

	pi.registerTool({
		name: "graph_impact",
        ...graphLoadout("graph_impact"),
		label: "Gentle Graph impact",
		description: "Find dependent files and related tests.",
		parameters: ImpactParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { target, projectRoot } = params as { target: string; projectRoot?: string };
			const root = resolveRoot(projectRoot,ctx?.cwd);
			return timedQuery(_toolCallId, "graph_impact", root, ctx?.sessionManager?.getSessionId?.(), () => sessionQueryDetails({kind:"impact",term:target,root}));
		},
	});

	pi.registerTool({
		name: "graph_register_pattern",
		...graphLoadout("graph_register_pattern"),
		label: "Gentle Graph register pattern",
		description: "Record a confirmed reuse pattern.",
		parameters: RegisterPatternParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { domain, entry, guidance, files, projectRoot } = params as {
				domain: string;
				entry: string;
				guidance: string;
				files?: string[];
				projectRoot?: string;
			};
			const root = resolveRoot(projectRoot,ctx?.cwd);
			return timedQuery(_toolCallId, "graph_register_pattern", root, ctx?.sessionManager?.getSessionId?.(),async () => {
        const start = performance.now();
        const text = formatPattern(graphRegisterPattern(domain,entry,guidance,files??[],root));
        const workMs = performance.now() - start;
        return {text, mode:"register", cacheHit:null, indexed:0, partial:false, engineMs:workMs, bootMs:0, workMs};
      });
		},
	});

	pi.on("before_agent_start", (event) => {
		const options=event.systemPromptOptions;
        appendSystemPromptOnce(options, options?.selectedTools?.includes("codemode") ? CODEMODE_HINT : GRAPH_PROMPT_HINT);
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		await closeQuerySessions();
        await writer.close();
        routes.clear();
		clearGitSession();
		clearMemoryCache();
	});
}
