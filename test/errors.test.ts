import assert from "node:assert/strict";
import { test } from "node:test";
import { explainGatewayError } from "../src/errors.ts";

const body = (status: number, code: string, message: string) =>
	`${status}: ${JSON.stringify({ code, message, type: "new_api_error" })}`;

test("user quota (Chinese) becomes a budget message", () => {
	const out = explainGatewayError(body(403, "insufficient_user_quota", "用户额度不足, 剩余额度: ＄0.000000 (request id: abc123)"));
	assert.match(out ?? "", /budget is used up/);
	assert.match(out ?? "", /request id abc123/);
	assert.match(explainGatewayError(body(403, "insufficient_user_quota", "预扣费额度失败, 用户剩余额度: 1, 需要预扣费额度: 2")) ?? "", /budget/);
});

test("token quota", () => {
	const out = explainGatewayError(
		body(403, "pre_consume_token_quota_failed", "token quota is not enough, token remain quota: 0, need quota: 5"),
	);
	assert.match(out ?? "", /key has reached its own spending limit/);
});

test("model not in group", () => {
	const raw =
		'503: {"code":"model_not_found","message":"No available channel for model cc/claude-opus-5 under group default (distributor) (request id: 2026)","type":"new_api_error"}';
	const out = explainGatewayError(raw, "cc/claude-opus-5") ?? "";
	assert.match(out, /"cc\/claude-opus-5" is not available for your UdK account \(group "default"\)/);
	assert.match(out, /standard/);
});

test("bad key, overload, unknown", () => {
	assert.match(explainGatewayError(body(401, "", "Invalid token (request id: x)")) ?? "", /did not accept your API key/);
	assert.match(explainGatewayError(body(401, "", "This token has expired")) ?? "", /expired/);
	assert.match(explainGatewayError("502: bad gateway", "standard") ?? "", /busy or offline/);
	assert.equal(explainGatewayError("400: context length exceeded"), undefined);
	assert.equal(explainGatewayError("Request was aborted"), undefined);
});
