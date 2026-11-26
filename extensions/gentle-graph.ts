import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendSystemPromptOnce } from "../lib/append-system-prompt.ts";
import {
	graphGuide,
	graphImpact,
	graphInspect,
	graphRegisterPattern,
} from "../lib/gentle-graph/index.ts";
import { clearMemoryCache } from "../lib/gentle-graph/store.ts";

import { formatGuide, formatImpact, formatInspect, formatPattern } from "../lib/gentle-graph/format.ts";

const GRAPH_PROMPT_HINT = "Use graph_guide for reuse, graph_inspect for callers, and graph_impact before refactoring. Use grep for literal searches.";

function resolveRoot(explicitRoot?: string, ctxCwd?: string): string {
	return explicitRoot || ctxCwd || process.env.GENTLE_WORKTREE_ROOT || process.cwd();
}

function asText(value: string) {
	return {
		content: [{ type: "text" as const, text: value }],
		details: {},
	};
}

const GuideParams = Type.Object({
	intent: Type.String(),
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

export default function gentleGraphExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "graph_guide",
		label: "Gentle Graph guide",
		description: "Find reusable modules, patterns and contracts.",
		parameters: GuideParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { intent, projectRoot, limit } = params as {
				intent: string;
				projectRoot?: string;
				limit?: number;
			};
			return asText(formatGuide(graphGuide(intent, { projectRoot: resolveRoot(projectRoot, ctx?.cwd), limit })));
		},
	});

	pi.registerTool({
		name: "graph_inspect",
		label: "Gentle Graph inspect",
		description: "Inspect a symbol and its callers and callees.",
		parameters: InspectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { symbol, depth, projectRoot } = params as {
				symbol: string;
				depth?: number;
				projectRoot?: string;
			};
			return asText(formatInspect(graphInspect(symbol, { projectRoot: resolveRoot(projectRoot, ctx?.cwd), depth })));
		},
	});

	pi.registerTool({
		name: "graph_impact",
		label: "Gentle Graph impact",
		description: "Find dependent files and related tests.",
		parameters: ImpactParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { target, projectRoot } = params as { target: string; projectRoot?: string };
			return asText(formatImpact(graphImpact(target, { projectRoot: resolveRoot(projectRoot, ctx?.cwd) })));
		},
	});

	pi.registerTool({
		name: "graph_register_pattern",
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
			return asText(
				formatPattern(graphRegisterPattern(domain, entry, guidance, files ?? [], resolveRoot(projectRoot, ctx?.cwd))),
			);
		},
	});

	pi.on("before_agent_start", (event) => {
		appendSystemPromptOnce(event.systemPromptOptions, GRAPH_PROMPT_HINT);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		clearMemoryCache();
	});
}
