import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
	version?: string;
	main?: string;
	exports?: { "."?: { types?: string; default?: string } };
	files?: string[];
	pi?: { extensions?: string[]; prompts?: string[] };
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
	version?: string;
	packages?: {
		""?: {
			version?: string;
			peerDependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
	};
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

test("package manifest pins the tested Pi development release", () => {
	const testedPiVersions = {
		codingAgent: packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
		tui: packageJson.devDependencies?.["@earendil-works/pi-tui"],
	};
	assert.deepEqual(testedPiVersions, { codingAgent: "0.80.7", tui: "0.80.7" });
	assert.deepEqual(
		{
			codingAgent: packageLock.packages?.[""]?.devDependencies?.["@earendil-works/pi-coding-agent"],
			tui: packageLock.packages?.[""]?.devDependencies?.["@earendil-works/pi-tui"],
		},
		testedPiVersions,
	);
});

test("package manifest retains the supported Pi 0.80.6 peer baseline", () => {
	const supportedPiVersions = {
		codingAgent: packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		tui: packageJson.peerDependencies?.["@earendil-works/pi-tui"],
	};
	assert.deepEqual(supportedPiVersions, { codingAgent: ">=0.80.6", tui: ">=0.80.6" });
	assert.deepEqual(
		{
			codingAgent: packageLock.packages?.[""]?.peerDependencies?.["@earendil-works/pi-coding-agent"],
			tui: packageLock.packages?.[""]?.peerDependencies?.["@earendil-works/pi-tui"],
		},
		supportedPiVersions,
	);
});

test("package manifest keeps npm lock metadata coherent", () => {
	assert.ok(existsSync("package-lock.json"), "npm lock must be present");
	assert.equal(packageLock.version, packageJson.version, "top-level lock version must match package version");
	assert.equal(packageLock.packages?.[""]?.version, packageJson.version, "root lock package must match package version");
	assert.ok(!existsSync("bun.lock"), "stale Bun lock must not coexist with npm lock");
});
