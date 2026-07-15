import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
	main?: string;
	exports?: { "."?: { types?: string; default?: string } };
	files?: string[];
	pi?: { extensions?: string[]; prompts?: string[] };
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

test("package manifest exposes only the compiled extension and dist-contained assets", () => {
	assert.equal(packageJson.main, "./dist/extensions/index.js");
	assert.deepEqual(packageJson.exports?.["."], {
		types: "./dist/extensions/index.d.ts",
		default: "./dist/extensions/index.js",
	});
	assert.deepEqual(packageJson.pi?.extensions, ["./dist/extensions/index.js"]);
	assert.deepEqual(packageJson.pi?.prompts, [], "internal worker prompts must not be exposed as Pi prompt resources");
	assert.deepEqual(packageJson.files, ["dist", "README.md", "LICENSE"]);
	assert.ok(!packageJson.files?.includes("src"), "TypeScript sources must not be published");
	assert.ok(!packageJson.files?.includes("extensions"), "source extension entries must not be published");
	assert.ok(!packageJson.files?.includes("prompts"), "worker prompts ship under dist only");
	assert.ok(!packageJson.files?.includes("profiles"), "worker profiles ship under dist only");
});

test("package manifest locks the Pi 0.80.6 development and peer baseline", () => {
	assert.deepEqual(
		{
			codingAgent: packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
			tui: packageJson.devDependencies?.["@earendil-works/pi-tui"],
		},
		{ codingAgent: "0.80.6", tui: "0.80.6" },
	);
	assert.deepEqual(
		{
			codingAgent: packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
			tui: packageJson.peerDependencies?.["@earendil-works/pi-tui"],
		},
		{ codingAgent: ">=0.80.6", tui: ">=0.80.6" },
	);
	assert.ok(existsSync("package-lock.json"), "npm lock must be present");
	assert.ok(!existsSync("bun.lock"), "stale Bun lock must not coexist with npm lock");
});
