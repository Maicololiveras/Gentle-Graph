import {sessionQueryDetails,closeQuerySessions,type QueryReply} from "../lib/gentle-graph/query-session.ts";
import { appendFileSync } from "node:fs";
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

async function timedQuery(id: string, tool: string, query: () => Promise<QueryReply>) {
  const trace = process.env.GENTLE_BENCH_ENGINE_TRACE;
  const started = performance.now();
  const {text,mode,indexed,partial}=await query();
  const engineMs=performance.now()-started;
  if(trace)try{appendFileSync(trace,JSON.stringify({id,tool,engineMs})+"\n");}
  catch{/* Optional trace file. */}
  return {content:[{type:"text" as const,text}],details:{gentleGraph:{engineMs,mode,indexed,partial}}};
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
			return timedQuery(_toolCallId, "graph_guide", () => sessionQueryDetails({kind:"guide",term:intent,root:resolveRoot(projectRoot,ctx?.cwd), limit, includeSnippets}));
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
			return timedQuery(_toolCallId, "graph_inspect", () => sessionQueryDetails({kind:"inspect",term:symbol,root:resolveRoot(projectRoot,ctx?.cwd), depth}));
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
			return timedQuery(_toolCallId, "graph_impact", () => sessionQueryDetails({kind:"impact",term:target,root:resolveRoot(projectRoot,ctx?.cwd)}));
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
			return timedQuery(_toolCallId,"graph_register_pattern",async()=>({
        text:formatPattern(graphRegisterPattern(domain,entry,guidance,files??[],resolveRoot(projectRoot,ctx?.cwd))),
        mode:"register",indexed:0,partial:false
      }));
		},
	});

	pi.on("before_agent_start", (event) => {
		const options=event.systemPromptOptions;
        appendSystemPromptOnce(options, options?.selectedTools?.includes("codemode") ? CODEMODE_HINT : GRAPH_PROMPT_HINT);
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		await closeQuerySessions();
		clearGitSession();
		clearMemoryCache();
	});
}
