/**
 * Client for the UdK new-api gateway (api.udk.digital) and its authentik login.
 *
 * No pi imports here, so this module can be exercised from plain node scripts and tests.
 *
 * Login chain (verified against new-api v1.0.0-rc.40 and auth.udk.digital):
 *   1. POST {api}/api/oauth/state {provider:"oidc",intent:"login"}  -> data.flow_token (= OAuth state)
 *   2. GET  {auth}/application/o/authorize/?client_id&redirect_uri&state...  -> 302 into the authentik flow
 *   3. authentik flow executor: submit identification (+password on the same stage), follow stages
 *      until xak-flow-redirect, then follow redirects until we land on {api}/oauth/oidc?code&state
 *   4. GET  {api}/api/oauth/oidc?code&state  -> data.access_token (dashboard Bearer)
 *
 * Nothing in here logs or returns the password; errors never include request bodies.
 */

export const DEFAULT_API_BASE = "https://api.udk.digital";

export type GatewayErrorKind = "credentials" | "network" | "server" | "unsupported" | "cancelled";

/** authentik flow page `/if/flow/<slug>/?…` → its JSON executor URL, else undefined. */
export function flowExecutorUrl(page: URL): URL | undefined {
	const match = /^\/if\/flow\/([^/]+)\/?$/.exec(page.pathname);
	if (!match) return undefined;
	return new URL(`/api/v3/flows/executor/${match[1]}/?query=${encodeURIComponent(page.search.slice(1))}`, page);
}

export class GatewayError extends Error {
	readonly kind: GatewayErrorKind;
	constructor(message: string, kind: GatewayErrorKind = "server") {
		super(message);
		this.name = "GatewayError";
		this.kind = kind;
	}
}

export interface GatewayStatus {
	systemName: string;
	version: string;
	oidcEnabled: boolean;
	oidcClientId: string;
	oidcAuthorizationEndpoint: string;
	serverAddress: string;
	quotaPerUnit: number;
	currencySymbol: string;
}

export interface DashboardSession {
	accessToken: string;
	accessExpiresAt?: number;
	sessionId?: string;
	user: GatewayUser;
}

export interface GatewayUser {
	id: number;
	username: string;
	displayName?: string;
	email?: string;
	group: string;
	quota: number;
	usedQuota: number;
}

export interface TokenUsage {
	name: string;
	unlimitedQuota: boolean;
	totalUsed: number;
	totalAvailable: number;
	expiresAt: number;
}

/** Minimal cookie jar: enough for authentik's session cookie across hosts. */
class CookieJar {
	private readonly cookies = new Map<string, Map<string, string>>();

	store(url: URL, response: Response): void {
		const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		for (const raw of setCookies) {
			const [pair, ...attrs] = raw.split(";");
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			let domain = url.hostname;
			for (const attr of attrs) {
				const [k, v] = attr.split("=");
				if (k?.trim().toLowerCase() === "domain" && v) domain = v.trim().replace(/^\./, "");
			}
			let bucket = this.cookies.get(domain);
			if (!bucket) {
				bucket = new Map();
				this.cookies.set(domain, bucket);
			}
			const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()));
			if (expired || value === "") bucket.delete(name);
			else bucket.set(name, value);
		}
	}

	header(url: URL): string | undefined {
		const parts: string[] = [];
		for (const [domain, bucket] of this.cookies) {
			if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
				for (const [k, v] of bucket) parts.push(`${k}=${v}`);
			}
		}
		return parts.length ? parts.join("; ") : undefined;
	}

	get(name: string): string | undefined {
		for (const bucket of this.cookies.values()) {
			const v = bucket.get(name);
			if (v !== undefined) return v;
		}
		return undefined;
	}
}

interface ApiEnvelope<T> {
	success?: boolean;
	message?: string;
	data?: T;
}

const USER_AGENT = "pi-udk/0.1 (+https://api.udk.digital)";

export class GatewayClient {
	readonly apiBase: string;
	private readonly signal?: AbortSignal;

	constructor(apiBase: string = DEFAULT_API_BASE, signal?: AbortSignal) {
		this.apiBase = apiBase.replace(/\/+$/, "");
		this.signal = signal;
	}

	// ---------- low-level ----------

	private async fetchRaw(url: URL, init: RequestInit, jar?: CookieJar): Promise<Response> {
		const headers = new Headers(init.headers);
		if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
		const cookie = jar?.header(url);
		if (cookie) headers.set("cookie", cookie);
		let response: Response;
		try {
			response = await fetch(url, { ...init, headers, redirect: "manual", signal: this.signal });
		} catch (error) {
			if (this.signal?.aborted) throw new GatewayError("Cancelled.", "cancelled");
			const detail = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
			throw new GatewayError(`Could not reach ${url.host}: ${detail}`, "network");
		}
		jar?.store(url, response);
		return response;
	}

	private async api<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		options: {
			bearer?: string;
			userId?: number;
			body?: unknown;
			query?: Record<string, string>;
			headers?: Record<string, string>;
		} = {},
	): Promise<T> {
		const url = new URL(path, `${this.apiBase}/`);
		for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
		const headers: Record<string, string> = { accept: "application/json", ...options.headers };
		if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
		// rc.40's web UI no longer sends it, older builds require it; harmless either way.
		if (options.userId !== undefined) headers["new-api-user"] = String(options.userId);
		if (options.body !== undefined) headers["content-type"] = "application/json";
		const response = await this.fetchRaw(url, {
			method,
			headers,
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
		});
		const text = await response.text();
		let parsed: ApiEnvelope<T> | undefined;
		try {
			parsed = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;
		} catch {
			throw new GatewayError(`${method} ${url.pathname}: HTTP ${response.status}, not JSON`, "server");
		}
		if (response.status === 401 || response.status === 403) {
			throw new GatewayError(parsed?.message || `${method} ${url.pathname}: HTTP ${response.status}`, "credentials");
		}
		if (!response.ok) {
			throw new GatewayError(parsed?.message || `${method} ${url.pathname}: HTTP ${response.status}`, "server");
		}
		// /api/usage/token returns {code:true,...}; everything else uses {success:...}
		if (parsed && parsed.success === false) {
			throw new GatewayError(parsed.message || `${method} ${url.pathname} failed`, "server");
		}
		return parsed?.data as T;
	}

	// ---------- public, unauthenticated ----------

	async status(): Promise<GatewayStatus> {
		const d = await this.api<Record<string, unknown>>("GET", "/api/status");
		return {
			systemName: String(d.system_name ?? "new-api"),
			version: String(d.version ?? ""),
			oidcEnabled: d.oidc_enabled === true,
			oidcClientId: String(d.oidc_client_id ?? ""),
			oidcAuthorizationEndpoint: String(d.oidc_authorization_endpoint ?? ""),
			serverAddress: String(d.server_address ?? this.apiBase),
			quotaPerUnit: Number(d.quota_per_unit ?? 500000) || 500000,
			// quota_display_type USD|CNY|TOKENS|CUSTOM; UdK uses CUSTOM with symbol "&". Only trust USD.
			currencySymbol: d.display_in_currency && (d.quota_display_type ?? "USD") === "USD" ? "$" : "",
		};
	}

	// ---------- login ----------

	/**
	 * Headless UdK login: username/e-mail + password against authentik, completed through
	 * new-api's OIDC callback. Returns a dashboard session (Bearer access token).
	 */
	async loginWithPassword(
		username: string,
		password: string,
		onProgress: (message: string) => void = () => {},
	): Promise<DashboardSession> {
		const status = await this.status();
		if (!status.oidcEnabled || !status.oidcClientId || !status.oidcAuthorizationEndpoint) {
			throw new GatewayError("The gateway has UdK login (OIDC) disabled.", "unsupported");
		}
		const jar = new CookieJar();

		onProgress("Starting login…");
		const flow = await this.api<{ flow_token?: string }>("POST", "/api/oauth/state", {
			body: { provider: "oidc", intent: "login" },
		});
		const state = flow?.flow_token;
		if (!state) throw new GatewayError("Gateway did not issue a login state.", "server");

		const callback = `${status.serverAddress.replace(/\/+$/, "")}/oauth/oidc`;
		const authorize = new URL(status.oidcAuthorizationEndpoint);
		authorize.searchParams.set("client_id", status.oidcClientId);
		authorize.searchParams.set("redirect_uri", callback);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("scope", "openid profile email");
		authorize.searchParams.set("state", state);

		onProgress("Contacting UdK login…");
		const first = await this.fetchRaw(authorize, { method: "GET" }, jar);
		let landing = first.headers.get("location");
		if (first.status < 300 || first.status >= 400 || !landing) {
			throw new GatewayError(`UdK login did not redirect (HTTP ${first.status}).`, "server");
		}
		let landingUrl = new URL(landing, authorize);

		// Already-authenticated sessions can skip straight to the callback (not in a fresh jar, but be safe).
		let code: string | undefined;
		if (!isCallback(landingUrl, callback)) {
			const executor = flowExecutorUrl(landingUrl);
			if (!executor) throw new GatewayError(`Unexpected login page: ${landingUrl.pathname}`, "unsupported");
			onProgress("Checking credentials…");
			const next = await this.runAuthentikFlow(executor, username, password, jar);
			// After authentication authentik goes back to /authorize, which usually starts a second
			// flow (the provider's authorization/consent flow). Drive every flow page the same way.
			landingUrl = await this.followToCallback(new URL(next, executor), callback, jar, async (flowExecutor) => {
				onProgress("Confirming access…");
				return this.runAuthentikFlow(flowExecutor, username, password, jar);
			});
		}
		code = landingUrl.searchParams.get("code") ?? undefined;
		const returnedState = landingUrl.searchParams.get("state");
		const oauthError = landingUrl.searchParams.get("error");
		if (oauthError) {
			throw new GatewayError(
				landingUrl.searchParams.get("error_description") || `UdK login refused: ${oauthError}`,
				oauthError === "access_denied" ? "credentials" : "server",
			);
		}
		if (!code || returnedState !== state) throw new GatewayError("UdK login returned no authorization code.", "server");

		onProgress("Signing in to the gateway…");
		const session = await this.api<{
			access_token?: string;
			access_expires_at?: number;
			session?: { sid?: string };
			user?: Record<string, unknown>;
		}>("GET", "/api/oauth/oidc", { query: { code, state } });
		if (!session?.access_token || !session.user) {
			throw new GatewayError("Gateway login succeeded but returned no session token.", "unsupported");
		}
		return {
			accessToken: session.access_token,
			accessExpiresAt: session.access_expires_at,
			sessionId: session.session?.sid,
			user: toUser(session.user),
		};
	}

	/**
	 * Drive authentik's flow executor through identification/password stages.
	 * Returns the redirect target once the flow completes.
	 */
	private async runAuthentikFlow(executor: URL, username: string, password: string, jar: CookieJar): Promise<string> {
		const headers = (): Record<string, string> => {
			const h: Record<string, string> = {
				accept: "application/json",
				"content-type": "application/json",
				origin: executor.origin,
				referer: `${executor.origin}/`,
			};
			const csrf = jar.get("authentik_csrf");
			if (csrf) h["x-authentik-csrf"] = csrf;
			return h;
		};

		let challenge = await this.flowStep(executor, { method: "GET", headers: headers() }, jar);
		let identified = false;
		let passwordSent = false;

		for (let step = 0; step < 10; step++) {
			const component = String(challenge.component ?? "");
			const errors = flowErrors(challenge);

			switch (component) {
				case "xak-flow-redirect":
					return String(challenge.to ?? "");
				case "ak-stage-identification": {
					if (identified) throw new GatewayError(errors || "Username or password is wrong.", "credentials");
					identified = true;
					const body: Record<string, unknown> = { component, uid_field: username };
					if (challenge.password_fields) {
						body.password = password;
						passwordSent = true;
					}
					challenge = await this.flowStep(executor, { method: "POST", headers: headers(), body: JSON.stringify(body) }, jar);
					break;
				}
				case "ak-stage-password": {
					if (passwordSent && errors) throw new GatewayError(errors, "credentials");
					if (passwordSent && step > 3) throw new GatewayError("Username or password is wrong.", "credentials");
					passwordSent = true;
					challenge = await this.flowStep(
						executor,
						{ method: "POST", headers: headers(), body: JSON.stringify({ component, password }) },
						jar,
					);
					break;
				}
				case "ak-stage-user-login": {
					// "Stay signed in?" prompt; answer no — this session is thrown away anyway.
					challenge = await this.flowStep(
						executor,
						{ method: "POST", headers: headers(), body: JSON.stringify({ component, remember_me: false }) },
						jar,
					);
					break;
				}
				case "ak-stage-consent": {
					challenge = await this.flowStep(
						executor,
						{ method: "POST", headers: headers(), body: JSON.stringify({ component, token: challenge.token }) },
						jar,
					);
					break;
				}
				case "ak-stage-access-denied":
					throw new GatewayError(
						String(challenge.error_message ?? "") || "UdK login denied access to the API application.",
						"credentials",
					);
				case "ak-stage-authenticator-validate":
				case "ak-stage-authenticator-totp":
				case "ak-stage-authenticator-webauthn":
					throw new GatewayError(
						"Your account requires a second factor, which the terminal login cannot do yet. Paste an API key instead.",
						"unsupported",
					);
				default:
					throw new GatewayError(
						`UdK login asked for a step the terminal cannot handle (${component || "unknown"}). Paste an API key instead.`,
						"unsupported",
					);
			}
		}
		throw new GatewayError("UdK login did not finish.", "server");
	}

	private async flowStep(url: URL, init: RequestInit, jar: CookieJar): Promise<Record<string, unknown>> {
		let response = await this.fetchRaw(url, init, jar);
		// authentik answers a POST with 302 back to the executor GET
		for (let i = 0; i < 3 && response.status >= 300 && response.status < 400; i++) {
			const loc = response.headers.get("location");
			if (!loc) break;
			response = await this.fetchRaw(new URL(loc, url), { method: "GET", headers: { accept: "application/json" } }, jar);
		}
		if (!response.ok) throw new GatewayError(`UdK login: HTTP ${response.status}`, "server");
		try {
			return (await response.json()) as Record<string, unknown>;
		} catch {
			throw new GatewayError("UdK login returned an unexpected page.", "server");
		}
	}

	private async followToCallback(
		start: URL,
		callback: string,
		jar: CookieJar,
		runFlow: (executor: URL) => Promise<string>,
	): Promise<URL> {
		let url = start;
		let flows = 0;
		for (let i = 0; i < 12; i++) {
			if (isCallback(url, callback)) return url;
			const executor = flowExecutorUrl(url);
			if (executor) {
				if (++flows > 3) throw new GatewayError("UdK login went through too many steps.", "server");
				url = new URL(await runFlow(executor), executor);
				continue;
			}
			const response = await this.fetchRaw(url, { method: "GET", headers: { accept: "text/html" } }, jar);
			const loc = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && loc) {
				url = new URL(loc, url);
				continue;
			}
			throw new GatewayError(`UdK login stopped at ${url.host}${url.pathname} (HTTP ${response.status}).`, "unsupported");
		}
		throw new GatewayError("UdK login redirected too many times.", "server");
	}

	async logout(session: DashboardSession): Promise<void> {
		try {
			await this.api("POST", "/api/user/auth/logout", {
				bearer: session.accessToken,
				userId: session.user.id,
				// SessionCookieOriginGuard wants a same-origin Origin when cookies are marked secure
				headers: {
					origin: new URL(this.apiBase).origin,
					...(session.sessionId ? { "x-auth-session": session.sessionId } : {}),
				},
			});
		} catch {
			// best effort — the session expires on its own
		}
	}

	// ---------- authenticated (dashboard session) ----------

	async self(session: DashboardSession): Promise<GatewayUser> {
		const d = await this.api<Record<string, unknown>>("GET", "/api/user/self", {
			bearer: session.accessToken,
			userId: session.user.id,
		});
		return toUser(d);
	}

	/** Model ids the account can use (union over its usable groups). */
	async userModels(session: DashboardSession): Promise<string[]> {
		const d = await this.api<string[]>("GET", "/api/user/models", {
			bearer: session.accessToken,
			userId: session.user.id,
		});
		return Array.isArray(d) ? d.filter((m): m is string => typeof m === "string") : [];
	}

	/** Newest key with exactly this name, if any. Search is LIKE-based, so filter for equality. */
	async findApiKey(session: DashboardSession, name: string): Promise<{ id: number; status: number } | undefined> {
		const found = await this.api<{ items?: Array<{ id: number; name: string; status: number }> }>(
			"GET",
			"/api/token/search",
			{ bearer: session.accessToken, userId: session.user.id, query: { keyword: name, p: "1", size: "50" } },
		);
		const match = (found?.items ?? []).filter((t) => t.name === name).sort((a, b) => b.id - a.id)[0];
		return match ? { id: match.id, status: match.status } : undefined;
	}

	/** Full `sk-…` value of a key; list/search responses only carry masked keys. */
	async revealApiKey(session: DashboardSession, id: number): Promise<string> {
		const full = await this.api<{ key?: string }>("POST", `/api/token/${id}/key`, {
			bearer: session.accessToken,
			userId: session.user.id,
		});
		if (!full?.key) throw new GatewayError("Gateway did not return the key.", "server");
		return full.key.startsWith("sk-") ? full.key : `sk-${full.key}`;
	}

	/**
	 * Create an API key named `name` and return its full `sk-…` value.
	 * new-api's create endpoint returns neither id nor key, so look it up by exact name afterwards.
	 */
	async createApiKey(session: DashboardSession, name: string): Promise<{ id: number; key: string }> {
		const auth = { bearer: session.accessToken, userId: session.user.id };
		await this.api("POST", "/api/token/", {
			...auth,
			body: {
				name,
				expired_time: -1,
				remain_quota: 0,
				unlimited_quota: true, // the account quota still applies; this only drops the per-key cap
				model_limits_enabled: false,
				model_limits: "",
				allow_ips: "",
				group: "",
			},
		});
		const match = await this.findApiKey(session, name);
		if (!match) throw new GatewayError("Key was created but could not be found again.", "server");
		return { id: match.id, key: await this.revealApiKey(session, match.id) };
	}

	// ---------- API-key scoped ----------

	/** Validates a key and returns its usage; throws GatewayError("credentials") for a bad key. */
	async keyUsage(apiKey: string): Promise<TokenUsage> {
		const d = await this.api<Record<string, unknown>>("GET", "/api/usage/token/", { bearer: apiKey });
		if (!d) throw new GatewayError("Key was not accepted.", "credentials");
		return {
			name: String(d.name ?? ""),
			unlimitedQuota: d.unlimited_quota === true,
			totalUsed: Number(d.total_used ?? 0),
			totalAvailable: Number(d.total_available ?? 0),
			expiresAt: Number(d.expires_at ?? 0),
		};
	}

	/** OpenAI-style model list visible to the key. */
	async listModels(apiKey: string): Promise<string[]> {
		const url = new URL(`${this.apiBase}/v1/models`);
		const response = await this.fetchRaw(url, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
		});
		if (response.status === 401 || response.status === 403) throw new GatewayError("Key was not accepted.", "credentials");
		if (!response.ok) throw new GatewayError(`GET /v1/models: HTTP ${response.status}`, "server");
		const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
		return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
	}
}

function isCallback(url: URL, callback: string): boolean {
	const cb = new URL(callback);
	return url.origin === cb.origin && url.pathname.replace(/\/+$/, "") === cb.pathname.replace(/\/+$/, "");
}

function flowErrors(challenge: Record<string, unknown>): string {
	const errors = challenge.response_errors as Record<string, Array<{ string?: string }>> | undefined;
	if (!errors) return "";
	return Object.values(errors)
		.flat()
		.map((e) => e?.string)
		.filter(Boolean)
		.join(" ");
}

function toUser(d: Record<string, unknown>): GatewayUser {
	return {
		id: Number(d.id),
		username: String(d.username ?? ""),
		displayName: typeof d.display_name === "string" && d.display_name ? d.display_name : undefined,
		email: typeof d.email === "string" && d.email ? d.email : undefined,
		group: String(d.group ?? "default"),
		quota: Number(d.quota ?? 0),
		usedQuota: Number(d.used_quota ?? 0),
	};
}

/**
 * Format new-api quota. With a currency symbol: quota_per_unit units = 1 currency unit.
 * Without (custom/token display): the value in the same "credits" the web portal shows.
 */
export function formatQuota(quota: number, quotaPerUnit: number, symbol = "$"): string {
	const value = quota / quotaPerUnit;
	const n = value.toFixed(Math.abs(value) >= 100 ? 0 : 2);
	return symbol ? `${symbol}${n}` : `${n} credits`;
}
