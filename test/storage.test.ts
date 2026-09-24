import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pi-udk-test-"));
process.env.PI_CODING_AGENT_DIR = dir;

const storage = await import("../src/storage.ts");
const KEY = `sk-${"a".repeat(48)}`;

let n = 0;
beforeEach(() => {
	// fresh agent dir per test
	process.env.PI_CODING_AGENT_DIR = join(dir, String(n++));
});

const read = (name: string) => JSON.parse(readFileSync(join(storage.agentDir(), name), "utf8"));

test("auth.json: write keeps other providers, is 0600, and can be removed", () => {
	storage.writeStoredKey(KEY);
	const path = storage.paths.auth();
	writeFileSync(path, JSON.stringify({ ...read("auth.json"), anthropic: { type: "oauth", access: "x" } }));
	storage.writeStoredKey(`${KEY}b`);
	assert.deepEqual(read("auth.json").udk, { type: "api_key", key: `${KEY}b` });
	assert.equal(read("auth.json").anthropic.type, "oauth");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(storage.readStoredKey(), `${KEY}b`);
	assert.equal(storage.removeStoredKey(), true);
	assert.equal(storage.readStoredKey(), undefined);
	assert.equal(read("auth.json").anthropic.type, "oauth");
});

test("models.json migration removes only the udk block and keeps a 0600 backup", () => {
	storage.writeStoredKey(KEY); // creates the dir
	const models = {
		providers: {
			udk: { baseUrl: "https://api.udk.digital/v1", api: "openai-completions", apiKey: KEY, models: [{ id: "a" }, { id: "b" }] },
			ollama: { baseUrl: "http://localhost:11434/v1" },
		},
		modelOverrides: {},
	};
	writeFileSync(storage.paths.models(), JSON.stringify(models));

	assert.deepEqual(storage.inspectLegacyModelsEntry(), { present: true, hasLiteralKey: true, modelCount: 2 });
	assert.equal(storage.legacyLiteralKey(), KEY);

	const backup = storage.removeLegacyModelsEntry();
	assert.ok(backup);
	assert.equal(statSync(backup).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), models);
	assert.deepEqual(read("models.json"), { providers: { ollama: models.providers.ollama }, modelOverrides: {} });
	assert.equal(storage.inspectLegacyModelsEntry().present, false);
	assert.equal(storage.removeLegacyModelsEntry(), undefined, "second run is a no-op");
	assert.equal(readdirSync(storage.agentDir()).filter((f) => f.includes(".bak-pi-udk-")).length, 1);
});

test("env-var and shell-command apiKeys are not treated as literal keys", () => {
	storage.writeStoredKey(KEY);
	for (const apiKey of ["UDK_API_KEY", "!op read op://x/y", "$UDK_KEY"]) {
		writeFileSync(storage.paths.models(), JSON.stringify({ providers: { udk: { apiKey } } }));
		assert.equal(storage.legacyLiteralKey(), undefined, apiKey);
	}
});

test("settings.json default model is merged, not replaced", () => {
	storage.writeStoredKey(KEY);
	writeFileSync(storage.paths.settings(), JSON.stringify({ theme: "dark", defaultProvider: "ollama", defaultModel: "x" }));
	storage.writeDefaultModel("standard");
	assert.deepEqual(read("settings.json"), { theme: "dark", defaultProvider: "udk", defaultModel: "standard" });
	assert.deepEqual(storage.readDefaultModel(), { provider: "udk", model: "standard" });
});

test("plugin state is merged", () => {
	storage.writeState({ keyName: "pi-test" });
	storage.writeState({ dismissedOnboarding: true });
	assert.deepEqual(storage.readState(), { keyName: "pi-test", dismissedOnboarding: true });
});
