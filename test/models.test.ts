import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuota } from "../src/gateway.ts";
import { isExternal, modelInfo, sortModelIds, toProviderModel } from "../src/models.ts";

test("aliases sort first, external models last", () => {
	const ids = ["cc/claude-opus-5", "Qwen3.8-27B", "large", "cx/gpt-5.5", "standard", "small-fast", "glm-5.3-flash"];
	const sorted = sortModelIds(ids);
	assert.deepEqual(sorted.slice(0, 3), ["standard", "small-fast", "large"]);
	assert.ok(sorted.slice(-2).every(isExternal));
});

test("provider model config is complete for pi", () => {
	for (const id of ["standard", "cc/claude-opus-5", "cx/gpt-5.5", "something-new"]) {
		const m = toProviderModel(id);
		assert.equal(m.id, id);
		assert.ok(m.name);
		assert.ok(m.contextWindow > 0 && m.maxTokens > 0 && m.maxTokens <= m.contextWindow);
		assert.ok(m.input.includes("text"));
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
	assert.equal(modelInfo("something-new").tier, "local");
	assert.ok(isExternal("cc/claude-opus-5") && isExternal("cx/gpt-5.5") && !isExternal("standard"));
});

test("quota formatting", () => {
	assert.equal(formatQuota(500000, 500000, "$"), "$1.00");
	assert.equal(formatQuota(250000, 500000, ""), "0.50 credits");
	assert.equal(formatQuota(436751554, 500000, ""), "874 credits");
});
