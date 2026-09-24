/**
 * Writes to pi's config files, mirroring pi's own locking so concurrent pi processes stay consistent.
 *
 * pi (0.87) exposes no credential-writing API to extensions, so the plugin writes auth.json itself
 * the same way pi's FileAuthStorageBackend does: proper-lockfile lockSync(path, {realpath:false}),
 * retry on ELOCKED, file mode 0600 on creation, directory 0700. pi re-reads auth.json when its
 * revision changes, so no restart is needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";

export const PROVIDER_ID = "udk";

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
	return join(homedir(), ".pi", "agent");
}

export const paths = {
	auth: () => join(agentDir(), "auth.json"),
	models: () => join(agentDir(), "models.json"),
	settings: () => join(agentDir(), "settings.json"),
};

function lockWithRetry(path: string): () => void {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 20; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code = (error as { code?: string })?.code;
			if (code !== "ELOCKED") throw error;
			lastError = error;
			const until = Date.now() + 25;
			while (Date.now() < until) {
				/* spin, as pi does */
			}
		}
	}
	throw lastError ?? new Error(`Could not lock ${path}`);
}

/** Read-modify-write a JSON object file under pi's lock. `fn` returns the new object or undefined for no change. */
function updateJson(
	path: string,
	fn: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
	opts: { mode?: number; createIfMissing?: boolean } = {},
): boolean {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!existsSync(path)) {
		if (!opts.createIfMissing) return false;
		writeFileSync(path, "{}", { encoding: "utf-8", mode: opts.mode ?? 0o644 });
	}
	const release = lockWithRetry(path);
	try {
		const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
		const current = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const next = fn(current);
		if (next === undefined) return false;
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: opts.mode ?? 0o644 });
		return true;
	} finally {
		release();
	}
}

// ---------- auth.json ----------

export interface StoredUdkCredential {
	type: "api_key";
	key: string;
}

export function readStoredKey(): string | undefined {
	try {
		const data = JSON.parse(readFileSync(paths.auth(), "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
		const entry = data[PROVIDER_ID] as { type?: string; key?: unknown } | undefined;
		return entry?.type === "api_key" && typeof entry.key === "string" && entry.key ? entry.key : undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredKey(key: string): void {
	updateJson(
		paths.auth(),
		(current) => ({ ...current, [PROVIDER_ID]: { type: "api_key", key } satisfies StoredUdkCredential }),
		{ mode: 0o600, createIfMissing: true },
	);
	// mode only applies on creation; tighten an existing file that is looser than 0600
	try {
		chmodSync(paths.auth(), 0o600);
	} catch {
		/* not ours to fix if it fails (ACLs, other owner) */
	}
}

export function removeStoredKey(): boolean {
	return updateJson(paths.auth(), (current) => {
		if (!(PROVIDER_ID in current)) return undefined;
		const next = { ...current };
		delete next[PROVIDER_ID];
		return next;
	});
}

// ---------- models.json (legacy manual setup) ----------

export interface LegacyModelsEntry {
	/** The provider block exists in models.json and will shadow this extension's settings. */
	present: boolean;
	/** It carries a literal key (not $ENV or !command). The key itself is never returned to the UI. */
	hasLiteralKey: boolean;
	modelCount: number;
}

function readModelsJson(): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(paths.models(), "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function legacyBlock(): Record<string, unknown> | undefined {
	const providers = readModelsJson()?.providers as Record<string, Record<string, unknown>> | undefined;
	return providers?.[PROVIDER_ID];
}

/**
 * pi resolves models.json apiKey as "!command", an env var name (e.g. UDK_API_KEY), or a literal.
 * Only a literal is worth migrating; env var names are ALL_CAPS identifiers.
 */
function isLiteralKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 20 &&
		!value.startsWith("$") &&
		!value.startsWith("!") &&
		!/^[A-Z_][A-Z0-9_]*$/.test(value)
	);
}

export function inspectLegacyModelsEntry(): LegacyModelsEntry {
	const block = legacyBlock();
	return {
		present: !!block,
		hasLiteralKey: isLiteralKey(block?.apiKey),
		modelCount: Array.isArray(block?.models) ? (block.models as unknown[]).length : 0,
	};
}

/** Only for validating before migration; the value stays inside this process. */
export function legacyLiteralKey(): string | undefined {
	const key = legacyBlock()?.apiKey;
	return isLiteralKey(key) ? key : undefined;
}

/**
 * Remove providers.udk from models.json after backing the file up.
 * Returns the backup path. Other providers and top-level keys are preserved.
 */
export function removeLegacyModelsEntry(): string | undefined {
	const path = paths.models();
	if (!existsSync(path)) return undefined;
	const backup = `${path}.bak-pi-udk-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	let backedUp = false;
	updateJson(path, (current) => {
		const providers = current.providers as Record<string, unknown> | undefined;
		if (!providers || !(PROVIDER_ID in providers)) return undefined;
		copyFileSync(path, backup);
		chmodSync(backup, 0o600); // it contains the old plaintext key
		backedUp = true;
		const nextProviders = { ...providers };
		delete nextProviders[PROVIDER_ID];
		return { ...current, providers: nextProviders };
	});
	return backedUp ? backup : undefined;
}

// ---------- settings.json ----------

export function readDefaultModel(): { provider?: string; model?: string } {
	try {
		const s = JSON.parse(readFileSync(paths.settings(), "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
		return {
			provider: typeof s.defaultProvider === "string" ? s.defaultProvider : undefined,
			model: typeof s.defaultModel === "string" ? s.defaultModel : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * Persist the default model. pi's extension API only switches the session model, so write the same
 * two fields pi's /model selector writes. The running pi keeps its in-memory settings and only
 * writes fields it modified, so this survives until the user changes the model again.
 */
export function writeDefaultModel(modelId: string): void {
	updateJson(
		paths.settings(),
		(current) => ({ ...current, defaultProvider: PROVIDER_ID, defaultModel: modelId }),
		{ createIfMissing: true },
	);
}

// ---------- plugin state (first-run prompt) ----------

const statePath = () => join(agentDir(), "pi-udk.json");

export interface PluginState {
	/** User dismissed the first-run offer; do not ask again on startup. */
	dismissedOnboarding?: boolean;
	/** User declined migrating the models.json block; do not nag. */
	declinedMigration?: boolean;
	onboardedAt?: string;
	keyName?: string;
}

export function readState(): PluginState {
	try {
		return JSON.parse(readFileSync(statePath(), "utf-8")) as PluginState;
	} catch {
		return {};
	}
}

export function writeState(patch: Partial<PluginState>): void {
	updateJson(statePath(), (current) => ({ ...current, ...patch }), { createIfMissing: true });
}
