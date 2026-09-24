/**
 * Model metadata for the UdK gateway.
 *
 * /v1/models only returns ids, so context window, max output and vision support come from this
 * table. Unknown ids fall back to conservative defaults so a newly added gateway model still shows up.
 * Cost is left at 0: billing happens in new-api quota, which pi cannot see per-model; `/udk usage`
 * shows the real figure.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ModelTier = "alias" | "local" | "external";

export interface ModelInfo {
	name: string;
	tier: ModelTier;
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	/** Short line for the tutorial's model picker. */
	blurb?: string;
}

const K = 1024;

/** Aliases are the stable names users should pick; backing models get repointed by ops. */
export const ALIASES = ["standard", "small-fast", "large"] as const;

const KNOWN: Record<string, ModelInfo> = {
	standard: {
		name: "UdK standard",
		tier: "alias",
		contextWindow: 128 * K,
		maxTokens: 32 * K,
		vision: false,
		blurb: "good all-rounder, runs on UdK hardware",
	},
	"small-fast": {
		name: "UdK small-fast",
		tier: "alias",
		contextWindow: 128 * K,
		maxTokens: 32 * K,
		vision: true,
		blurb: "quickest answers, understands images, runs on UdK hardware",
	},
	large: {
		name: "UdK large",
		tier: "alias",
		contextWindow: 128 * K,
		maxTokens: 32 * K,
		vision: true,
		blurb: "the biggest model UdK hosts for you right now",
	},
	"qwen3.8-flash-next": { name: "Qwen3.8 Flash Next", tier: "local", contextWindow: 128 * K, maxTokens: 32 * K, vision: true },
	"Qwen3.8-27B": { name: "Qwen3.8 27B", tier: "local", contextWindow: 256 * K, maxTokens: 32 * K, vision: true },
	"unsloth/DeepSeek-V4-Flash-0731-GGUF": {
		name: "DeepSeek V4 Flash",
		tier: "local",
		contextWindow: 128 * K,
		maxTokens: 32 * K,
		vision: false,
	},
	"ggml-org/MiMo-V2.6-Flash-RL-GGUF": {
		name: "MiMo V2.6 Flash",
		tier: "local",
		contextWindow: 128 * K,
		maxTokens: 32 * K,
		vision: true,
	},
	"glm-5.3-flash": { name: "GLM 5.3 Flash", tier: "local", contextWindow: 64 * K, maxTokens: 16 * K, vision: true },
	"z-ai/glm-5.3-flash": { name: "GLM 5.3 Flash (z-ai)", tier: "local", contextWindow: 64 * K, maxTokens: 16 * K, vision: true },
	"tensorx/glm-5.3-flash": {
		name: "GLM 5.3 Flash (tensorx)",
		tier: "local",
		contextWindow: 64 * K,
		maxTokens: 16 * K,
		vision: true,
	},
};

function externalInfo(id: string): ModelInfo | undefined {
	if (id.startsWith("cc/")) {
		const base = id.slice(3);
		const haiku = base.includes("haiku");
		return {
			name: `Claude ${prettify(base.replace(/^claude-/, ""))} (via UdK)`,
			tier: "external",
			contextWindow: haiku ? 200 * K : 1000 * K,
			maxTokens: haiku ? 64 * K : 128 * K,
			vision: true,
		};
	}
	if (id.startsWith("cx/")) {
		return {
			name: `${prettify(id.slice(3)).replace(/^Gpt/, "GPT")} (via UdK)`,
			tier: "external",
			contextWindow: 272 * K,
			maxTokens: 128 * K,
			vision: true,
		};
	}
	return undefined;
}

function prettify(s: string): string {
	return s
		.replace(/-(\d{8})$/, "")
		.split("-")
		.map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
		.join(" ")
		.replace(/(\d) (\d)/g, "$1.$2");
}

export function modelInfo(id: string): ModelInfo {
	return (
		KNOWN[id] ??
		externalInfo(id) ?? {
			name: id,
			tier: "local",
			contextWindow: 32 * K,
			maxTokens: 8 * K,
			vision: false,
		}
	);
}

/** External models leave UdK (Anthropic/OpenAI, US). Surfaced in the tutorial and model names. */
export function isExternal(id: string): boolean {
	return modelInfo(id).tier === "external";
}

export function toProviderModel(id: string): ProviderModelConfig {
	const info = modelInfo(id);
	return {
		id,
		name: info.name,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: info.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
	};
}

/** Order: aliases first (in ALIASES order), then local models, then external, alphabetical within. */
export function sortModelIds(ids: string[]): string[] {
	const rank = (id: string) => {
		const a = (ALIASES as readonly string[]).indexOf(id);
		if (a >= 0) return a;
		return modelInfo(id).tier === "local" ? 10 : 20;
	};
	return [...new Set(ids)].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
}

/** Shown before the first login, and whenever the live list cannot be fetched. */
export const FALLBACK_MODEL_IDS = [...ALIASES];
