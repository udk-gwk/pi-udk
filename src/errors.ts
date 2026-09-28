/**
 * Turn new-api relay errors into messages a student can act on.
 *
 * pi shows provider errors as `<status>: <body>` where the body is new-api's JSON
 * `{code, message, type:"new_api_error"}`. Several messages are Chinese-only (quota) or
 * name internal concepts (group, channel, distributor).
 */

const KEYS_URL = "https://api.udk.digital/keys";

interface Parsed {
	status?: number;
	code?: string;
	message: string;
}

function parse(raw: string): Parsed {
	const m = /^(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(raw.trim());
	if (m) {
		try {
			const body = JSON.parse(m[2]) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
			const inner = body.error ?? body;
			return {
				status: Number(m[1]),
				code: typeof inner.code === "string" ? inner.code : undefined,
				message: typeof inner.message === "string" ? inner.message : raw,
			};
		} catch {
			/* fall through */
		}
	}
	const s = /^(\d{3}):/.exec(raw);
	return { status: s ? Number(s[1]) : undefined, message: raw };
}

/** Returns a friendlier text, or undefined to leave the original untouched. */
export function explainGatewayError(raw: string, modelId?: string): string | undefined {
	if (!raw) return undefined;
	const { status, code, message } = parse(raw);
	const requestId = /\(request id: ([^)]+)\)/.exec(message)?.[1];
	const ref = requestId ? ` (request id ${requestId})` : "";
	const model = modelId ? `"${modelId}"` : "this model";

	// user/account quota: "用户额度不足, 剩余额度: …", "预扣费额度失败, 用户剩余额度…", "user quota is not enough"
	if (code === "insufficient_user_quota" || /用户额度不足|用户剩余额度|user quota is not enough/.test(message)) {
		return `Your UdK AI budget is used up. Ask the GenKI team for more, or check your balance at https://api.udk.digital.${ref}`;
	}
	// per-key limit
	if (
		code === "pre_consume_token_quota_failed" ||
		/token quota is not enough|token quota is exhausted|TokenStatusExhausted/.test(message)
	) {
		return `This API key has reached its own spending limit. Raise or remove the limit at ${KEYS_URL}, or run /udk to get a new key.${ref}`;
	}
	// model not offered to this account's group
	const noChannel = /No available channel for model (.+?) under group (\S+)|分组 (\S+) 下模型 (.+?) 无可用渠道/.exec(message);
	if (noChannel || code === "model_not_found") {
		const m = noChannel?.[1] ?? noChannel?.[4];
		const group = noChannel?.[2] ?? noChannel?.[3];
		return (
			`${m ? `"${m}"` : model} is not available for your UdK account${group ? ` (group "${group}")` : ""}. ` +
			`Pick another model with /model — the UdK models "standard", "small-fast" and "large" work for everyone.${ref}`
		);
	}
	if (/has no access to model|has no access to any models/.test(message)) {
		return `Your API key is restricted and cannot use ${model}. Edit the key's model list at ${KEYS_URL}, or run /udk to get a new key.${ref}`;
	}
	// key problems
	if (/This token has expired/.test(message)) return `Your UdK API key has expired. Run /udk to log in and get a new one.${ref}`;
	if (status === 401 || /Invalid token|token status is unavailable|Token not provided/.test(message)) {
		return `The UdK gateway did not accept your API key (deleted or disabled?). Run /udk to log in again.${ref}`;
	}
	if (status === 429) return `The UdK gateway is rate-limiting you. Wait a minute and try again.${ref}`;
	if (status === 502 || status === 503 || status === 504) {
		return `The UdK model server behind ${model} is busy or offline right now (HTTP ${status}). Try again shortly or pick another model with /model.${ref}`;
	}
	return undefined;
}
