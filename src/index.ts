/**
 * pi-udk — use the UdK AI gateway (api.udk.digital) from pi.
 *
 *   /udk            guided setup: UdK login → personal API key → pick a model → test → tips
 *   /udk status     what is configured, key usage
 *   /udk models     refresh the model list from the gateway
 *   /udk key        paste an existing API key instead of logging in
 *   /udk logout     forget the stored key (the key itself stays valid on the gateway)
 *
 * The key is stored as an ordinary pi credential in ~/.pi/agent/auth.json under "udk".
 * Your UdK password is only sent to auth.udk.digital and is never written anywhere.
 */
import { hostname } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { type DashboardSession, DEFAULT_API_BASE, GatewayClient, GatewayError, formatQuota } from "./gateway.ts";
import { createForm, type FormResult } from "./form.ts";
import {
	ALIASES,
	FALLBACK_MODEL_IDS,
	isExternal,
	modelInfo,
	sortModelIds,
	toProviderModel,
} from "./models.ts";
import {
	PROVIDER_ID,
	inspectLegacyModelsEntry,
	legacyLiteralKey,
	paths,
	readDefaultModel,
	readState,
	readStoredKey,
	removeLegacyModelsEntry,
	removeStoredKey,
	writeDefaultModel,
	writeState,
	writeStoredKey,
} from "./storage.ts";

const API_BASE = (process.env.PI_UDK_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
const DASHBOARD_KEYS_URL = `${API_BASE}/keys`;
/** Models are re-listed at most this often during background refreshes. */
const MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default function udk(pi: ExtensionAPI) {
	registerProvider(pi, FALLBACK_MODEL_IDS.map(toProviderModel));

	pi.registerCommand("udk", {
		description: "UdK AI gateway: log in, get a key, pick a model (subcommands: status, models, key, logout)",
		getArgumentCompletions: (prefix) =>
			["setup", "status", "models", "key", "logout"]
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "setup";
			switch (sub) {
				case "setup":
				case "login":
					return onboard(pi, ctx);
				case "status":
					return showStatus(ctx);
				case "models":
					await refreshModelsNow(ctx);
					return;
				case "key":
					return pasteKeyFlow(pi, ctx);
				case "logout":
					return logout(ctx);
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Try /udk, /udk status, /udk models, /udk key, /udk logout.`, "warning");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const legacy = inspectLegacyModelsEntry();
		const hasKey = !!readStoredKey();
		const state = readState();

		if (hasKey) {
			if (legacy.present && !state.declinedMigration) {
				ctx.ui.notify(
					"pi-udk: a hand-written \"udk\" provider in models.json overrides this extension. Run /udk to clean it up.",
					"warning",
				);
			}
			return;
		}
		if (state.dismissedOnboarding) return;

		// Defer so the first-run prompt appears after pi has drawn its header.
		setTimeout(() => {
			void (async () => {
				const hint = legacy.present
					? "Found an older manual UdK setup in models.json. Move it to a login-managed key now?"
					: "Use the UdK AI gateway (api.udk.digital) with your UdK account. Set it up now? (takes a minute)";
				const choice = await ctx.ui.select(hint, ["Yes, set it up", "Not now", "Don't ask again"]);
				if (choice === "Yes, set it up") {
					const cmdCtx = ctx as ExtensionCommandContext;
					await onboard(pi, cmdCtx);
				} else if (choice === "Don't ask again") {
					writeState({ dismissedOnboarding: true });
					ctx.ui.notify("OK. Run /udk whenever you want to set it up.", "info");
				}
			})().catch((error) => ctx.ui.notify(`pi-udk: ${errorText(error)}`, "error"));
		}, 50);
	});
}

// ---------------------------------------------------------------------------------------------
// provider

let lastModelFetch = 0;

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
	pi.registerProvider(PROVIDER_ID, {
		name: "UdK",
		baseUrl: `${API_BASE}/v1`,
		api: "openai-completions",
		models,
		refreshModels: async (context) => {
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const stored = context.stored?.models?.map((m) => m.id) ?? [];
			const cached = stored.length ? sortModelIds(stored).map(toProviderModel) : models;
			if (!context.allowNetwork || !key || context.signal.aborted) return cached;
			if (!context.force && Date.now() - lastModelFetch < MODEL_REFRESH_INTERVAL_MS && stored.length) return cached;

			try {
				const ids = sortModelIds(await new GatewayClient(API_BASE, context.signal).listModels(key));
				if (!ids.length) return cached;
				lastModelFetch = Date.now();
				const fresh = ids.map(toProviderModel);
				await context.publish({
					persist: {
						models: fresh.map((m) => ({
							...m,
							api: "openai-completions",
							provider: PROVIDER_ID,
							baseUrl: `${API_BASE}/v1`,
						})),
						checkedAt: Date.now(),
					},
				});
				return fresh;
			} catch {
				// offline, gateway down, or key revoked: keep the last known list
				return cached;
			}
		},
	});
}

async function refreshModelsNow(ctx: ExtensionContext): Promise<string[]> {
	const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
	const err = result.errors.get(PROVIDER_ID);
	const ids = ctx.modelRegistry
		.getAll()
		.filter((m) => m.provider === PROVIDER_ID)
		.map((m) => m.id);
	if (err) ctx.ui.notify(`Could not refresh UdK models: ${err.message}`, "warning");
	else ctx.ui.notify(`UdK: ${ids.length} models available.`, "info");
	return ids;
}

// ---------------------------------------------------------------------------------------------
// onboarding

async function onboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("/udk setup needs the interactive terminal UI.", "warning");
		return;
	}

	// 1. welcome
	const existingKey = readStoredKey();
	const legacy = inspectLegacyModelsEntry();
	const intro = [
		"Welcome! This connects pi to the UdK AI gateway at api.udk.digital.",
		"",
		"1. You log in with your UdK account (same as the web portal).",
		"2. pi creates a personal API key for this computer and stores it in ~/.pi/agent/auth.json.",
		"3. You pick a model, we send a test message, and you get a few tips.",
		"",
		"Your password goes only to auth.udk.digital and is never saved.",
	];
	const start = await ctx.ui.select(
		intro.join("\n"),
		[
			existingKey ? "Log in again and replace my key" : "Log in with my UdK account",
			"Paste an API key I already have",
			...(legacy.present && legacy.hasLiteralKey ? ["Use the key from my existing models.json setup"] : []),
			...(existingKey ? ["Keep my current key, just pick a model"] : []),
			"Cancel",
		],
	);
	if (!start || start === "Cancel") return;

	let key: string | undefined;
	if (start.startsWith("Log in")) key = await loginFlow(ctx);
	else if (start.startsWith("Paste")) key = await askForKey(ctx);
	else if (start.startsWith("Use the key")) key = await adoptLegacyKey(ctx);
	else if (start.startsWith("Keep")) key = existingKey;
	if (!key) return;

	if (key !== existingKey) {
		writeStoredKey(key);
		writeState({ onboardedAt: new Date().toISOString() });
	}

	// 2. clean up the older models.json provider, which would shadow this one
	await offerLegacyCleanup(ctx);

	// 3. models
	const ids = await withLoader(ctx, "Loading your models…", async () => {
		await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
		return ctx.modelRegistry
			.getAll()
			.filter((m) => m.provider === PROVIDER_ID)
			.map((m) => m.id);
	});
	if (!ids?.length) {
		ctx.ui.notify("Key saved, but the model list could not be loaded. Try /udk models later.", "warning");
		return;
	}

	const chosen = await pickModel(ctx, ids);
	if (!chosen) {
		ctx.ui.notify("Key saved. Pick a UdK model any time with /model.", "info");
		return;
	}
	const model = ctx.modelRegistry.find(PROVIDER_ID, chosen);
	if (!model || !(await pi.setModel(model))) {
		ctx.ui.notify(`Could not switch to ${chosen}. Pick it with /model.`, "warning");
		return;
	}
	const makeDefault = await ctx.ui.confirm(
		"Default model",
		`Start pi with udk/${chosen} from now on?\n(Currently: ${describeDefault()})`,
	);
	if (makeDefault) writeDefaultModel(chosen);

	// 4. test message
	await testModel(ctx, chosen);

	// 5. tips
	await showTips(ctx, chosen, key);
}

async function loginFlow(ctx: ExtensionCommandContext): Promise<string | undefined> {
	let error: string | undefined;
	let username: string | undefined;

	for (let attempt = 0; attempt < 5; attempt++) {
		const form = await ctx.ui.custom<FormResult | null>((tui, theme, _kb, done) =>
			createForm(
				tui,
				theme,
				{
					title: "UdK login",
					intro: ["Your UdK username or e-mail and password — the same you use for the web portal."],
					fields: [
						{ id: "username", label: "User", initial: username, placeholder: "username or e-mail" },
						{ id: "password", label: "Password", secret: true, validate: (v) => (v ? undefined : "Enter your password.") },
					],
					error,
				},
				done,
			),
		);
		if (!form) return undefined;
		username = form.username;

		const outcome = await withLoader(ctx, "Logging in…", async (signal) => {
			const c = new GatewayClient(API_BASE, signal);
			const session = await c.loginWithPassword(form.username, form.password);
			try {
				const key = await obtainKey(c, session, ctx);
				return { session, key };
			} finally {
				await c.logout(session);
			}
		}, true).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
		form.password = "";

		if (outcome instanceof GatewayError) {
			if (outcome.kind === "cancelled") return undefined;
			if (outcome.kind === "credentials") {
				error = "UdK login failed: check username and password.";
				continue;
			}
			if (outcome.kind === "unsupported") {
				const next = await ctx.ui.select(`${outcome.message}`, ["Paste an API key instead", "Cancel"]);
				return next === "Paste an API key instead" ? askForKey(ctx) : undefined;
			}
			error = outcome.message;
			continue;
		}
		if (outcome instanceof Error) {
			error = outcome.message;
			continue;
		}
		if (!outcome) return undefined;
		const { session, key } = outcome;
		ctx.ui.notify(
			`Logged in as ${session.user.displayName || session.user.username} (group ${session.user.group}). Key saved.`,
			"info",
		);
		return key;
	}
	ctx.ui.notify("Too many failed attempts. Run /udk to try again.", "error");
	return undefined;
}

/** Reuse this machine's key if it already exists (same name), otherwise create one. */
async function obtainKey(client: GatewayClient, session: DashboardSession, _ctx: ExtensionContext): Promise<string> {
	const name = keyName();
	const existing = await client.findApiKey(session, name);
	// status 1 = enabled; disabled/expired/exhausted keys are left alone and a fresh one is made
	if (existing && existing.status === 1) {
		const key = await client.revealApiKey(session, existing.id);
		writeState({ keyName: name });
		return key;
	}
	const created = await client.createApiKey(session, name);
	writeState({ keyName: name });
	return created.key;
}

function keyName(): string {
	const host = hostname()
		.replace(/\.(local|lan|home|fritz\.box)$/i, "")
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.slice(0, 40);
	return `pi-${host || "computer"}`;
}

async function askForKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	let error: string | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		const form = await ctx.ui.custom<FormResult | null>((tui, theme, _kb, done) =>
			createForm(
				tui,
				theme,
				{
					title: "Paste a UdK API key",
					intro: [
						`Create one at ${DASHBOARD_KEYS_URL} (log in, "Create key"), copy it, and paste it here.`,
					],
					fields: [
						{
							id: "key",
							label: "API key",
							secret: true,
							placeholder: "sk-…",
							validate: (v) => (v.trim().length >= 20 ? undefined : "That does not look like an API key."),
						},
					],
					error,
				},
				done,
			),
		);
		if (!form) return undefined;
		const key = normaliseKey(form.key);
		const ok = await validateKey(ctx, key);
		if (ok === true) return key;
		if (ok === undefined) return undefined;
		error = ok;
	}
	return undefined;
}

async function adoptLegacyKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const key = legacyLiteralKey();
	if (!key) return undefined;
	const ok = await validateKey(ctx, key);
	if (ok === true) return key;
	if (ok === undefined) return undefined;
	ctx.ui.notify(`The key in models.json does not work any more (${ok}). Log in instead.`, "warning");
	return loginFlow(ctx);
}

/** true = valid, string = reason it is not, undefined = cancelled. */
async function validateKey(ctx: ExtensionCommandContext, key: string): Promise<true | string | undefined> {
	try {
		const usage = await withLoader(ctx, "Checking key…", (signal) => new GatewayClient(API_BASE, signal).keyUsage(key), true);
		return usage ? true : undefined;
	} catch (error) {
		if (error instanceof GatewayError && error.kind === "cancelled") return undefined;
		if (error instanceof GatewayError && error.kind === "credentials") return "The gateway did not accept this key.";
		return errorText(error);
	}
}

function normaliseKey(raw: string): string {
	const k = raw.trim().replace(/^Bearer\s+/i, "");
	return k.startsWith("sk-") ? k : `sk-${k}`;
}

async function offerLegacyCleanup(ctx: ExtensionCommandContext): Promise<void> {
	const legacy = inspectLegacyModelsEntry();
	if (!legacy.present) return;
	const move = await ctx.ui.confirm(
		"Older UdK setup found",
		[
			`~/.pi/agent/models.json has a hand-written "udk" provider (${legacy.modelCount} models${legacy.hasLiteralKey ? ", with the API key in plain text" : ""}).`,
			"It overrides this extension's model list and key.",
			"",
			"Remove it? A backup copy of models.json is kept next to it.",
		].join("\n"),
	);
	if (!move) {
		writeState({ declinedMigration: true });
		ctx.ui.notify("Left models.json unchanged. Its udk settings will keep taking precedence.", "info");
		return;
	}
	const backup = removeLegacyModelsEntry();
	writeState({ declinedMigration: false });
	if (backup) {
		ctx.ui.notify(
			`Removed the udk block from models.json. Backup (contains the old key, delete when happy): ${backup}`,
			"info",
		);
	}
}

async function pickModel(ctx: ExtensionCommandContext, ids: string[]): Promise<string | undefined> {
	const aliases = ALIASES.filter((a) => ids.includes(a));
	const others = ids.filter((id) => !(ALIASES as readonly string[]).includes(id));
	const label = (id: string) => {
		const info = modelInfo(id);
		const where = isExternal(id) ? "  ⚠ leaves UdK (external provider)" : "";
		return `${id}${info.blurb ? ` — ${info.blurb}` : ""}${where}`;
	};
	const options = [...aliases.map(label), ...(others.length ? ["More models…"] : []), "Skip"];
	const title = [
		"Pick a model.",
		"The three UdK names stay stable while the models behind them get upgraded — a good default.",
	].join("\n");
	const pick = await ctx.ui.select(title, options);
	if (!pick || pick === "Skip") return undefined;
	if (pick === "More models…") {
		const more = await ctx.ui.select(
			"All models your account can use.\nExternal ones (⚠) send your prompts to a company outside UdK.",
			[...others.map(label), "Back"],
		);
		if (!more || more === "Back") return pickModel(ctx, ids);
		return others.find((id) => label(id) === more);
	}
	return aliases.find((id) => label(id) === pick);
}

async function testModel(ctx: ExtensionCommandContext, modelId: string): Promise<void> {
	const model = ctx.modelRegistry.find(PROVIDER_ID, modelId);
	if (!model) return;
	const started = Date.now();
	const reply = await withLoader(
		ctx,
		`Sending a test message to ${modelId}…`,
		async (signal) => {
			const res = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: "You are a friendly assistant inside a terminal coding tool. Answer in one short sentence.",
					messages: [
						{
							role: "user",
							content: "Say hello to a new user at the Berlin University of the Arts (UdK) in one sentence.",
							timestamp: Date.now(),
						},
					],
				},
				{ signal },
			);
			if (res.stopReason === "error") throw new Error(res.errorMessage || "model returned an error");
			return res.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();
		},
		true,
	).catch((e: unknown) => e);
	if (reply instanceof Error) {
		ctx.ui.notify(`Test message failed: ${reply.message}`, "warning");
		return;
	}
	if (typeof reply === "string") {
		const secs = ((Date.now() - started) / 1000).toFixed(1);
		ctx.ui.notify(`✓ ${modelId} answered in ${secs}s: ${reply.slice(0, 300) || "(empty reply)"}`, "info");
	}
}

async function showTips(ctx: ExtensionCommandContext, modelId: string, key: string): Promise<void> {
	let usage = "";
	try {
		const client = new GatewayClient(API_BASE);
		const [u, status] = await Promise.all([client.keyUsage(key), client.status()]);
		usage = `Used so far with this key: ${formatQuota(u.totalUsed, status.quotaPerUnit, status.currencySymbol)}.`;
	} catch {
		/* usage is a nice-to-have */
	}
	const lines = [
		`You're set up with udk/${modelId}.`,
		"",
		"A few things worth knowing:",
		"• Just type what you want and press Enter. Esc stops the model.",
		"• @ adds a file to your message, !cmd runs a shell command and shows the model its output.",
		"• /model (Ctrl+L) switches models; Shift+Tab changes how hard it thinks.",
		"• /new starts over, /resume opens an earlier session, /tree jumps back in this one.",
		"• pi can edit files and run commands without asking — try it in a git repo so you can undo.",
		"• Models marked ⚠ send your prompts to an outside company; the UdK ones stay on UdK hardware.",
		"",
		...(usage ? [usage] : []),
		`/udk status shows usage, /udk models re-reads the model list. Keys: ${DASHBOARD_KEYS_URL}`,
	];
	await ctx.ui.select(lines.join("\n"), ["Got it"]);
}

// ---------------------------------------------------------------------------------------------
// other subcommands

async function pasteKeyFlow(_pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("/udk key needs the interactive terminal UI.", "warning");
		return;
	}
	const key = await askForKey(ctx);
	if (!key) return;
	writeStoredKey(key);
	await offerLegacyCleanup(ctx);
	await refreshModelsNow(ctx);
	ctx.ui.notify("UdK key saved. Pick a model with /model.", "info");
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const key = readStoredKey();
	const legacy = inspectLegacyModelsEntry();
	const lines: string[] = [`Gateway: ${API_BASE}`];
	if (!key) {
		lines.push("Key: none stored — run /udk to set up.");
	} else {
		try {
			const client = new GatewayClient(API_BASE);
			const [u, status] = await Promise.all([client.keyUsage(key), client.status()]);
			lines.push(`Key: "${u.name}" (stored in ${paths.auth()})`);
			const used = formatQuota(u.totalUsed, status.quotaPerUnit, status.currencySymbol);
			const left = u.unlimitedQuota ? "no per-key limit" : `${formatQuota(u.totalAvailable, status.quotaPerUnit, status.currencySymbol)} left`;
			lines.push(`Usage: ${used} used, ${left}${u.expiresAt > 0 ? `, expires ${new Date(u.expiresAt * 1000).toLocaleDateString()}` : ""}`);
		} catch (error) {
			lines.push(`Key: stored in ${paths.auth()}`);
			lines.push(`Usage: unavailable (${errorText(error)})`);
		}
	}
	const count = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID).length;
	lines.push(`Models: ${count}`);
	if (ctx.model?.provider === PROVIDER_ID) lines.push(`Current model: udk/${ctx.model.id}`);
	lines.push(`Default model: ${describeDefault()}`);
	if (legacy.present) lines.push("⚠ models.json still has a hand-written \"udk\" provider that overrides this extension (/udk to clean up).");
	ctx.ui.notify(lines.join("\n"), "info");
}

async function logout(ctx: ExtensionCommandContext): Promise<void> {
	if (!readStoredKey()) {
		ctx.ui.notify("No UdK key stored.", "info");
		return;
	}
	const ok = await ctx.ui.confirm(
		"Forget UdK key?",
		`Removes the key from ${paths.auth()}. It stays valid on the gateway — delete it at ${DASHBOARD_KEYS_URL} if you no longer need it.`,
	);
	if (!ok) return;
	removeStoredKey();
	await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: false });
	ctx.ui.notify("UdK key removed from pi.", "info");
}

// ---------------------------------------------------------------------------------------------
// helpers

function describeDefault(): string {
	const d = readDefaultModel();
	return d.provider && d.model ? `${d.provider}/${d.model}` : "not set";
}

/** Run `work` behind a bordered spinner. Returns undefined if the user cancelled with Esc. */
async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	work: (signal: AbortSignal) => Promise<T>,
	cancellable = false,
): Promise<T | undefined> {
	let failure: unknown;
	let failed = false;
	const result = await ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable });
		loader.onAbort = () => done(undefined);
		work(loader.signal)
			.then((value) => done(value))
			.catch((error: unknown) => {
				if (loader.signal.aborted) return; // user cancelled; done() already called
				failed = true;
				failure = error;
				done(undefined);
			});
		return loader;
	});
	if (failed) throw failure;
	return result;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
