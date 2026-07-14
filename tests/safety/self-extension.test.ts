import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	getOrchestratorSelfEntryPaths,
	isRecursiveOrchestratorExtensionSource,
} from "../../src/safety/self-extension.js";

function createLayout(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("self-entry candidates cover source and compiled layouts without a generated dist dependency", () => {
	const root = createLayout("pi-agent-team-layout-");
	const sourceModule = join(root, "src/safety/self-extension.ts");
	const compiledModule = join(root, "dist/src/safety/self-extension.js");
	const expected = [
		join(root, "extensions/index.ts"),
		join(root, "extensions/pi-agent-team/index.ts"),
		join(root, "dist/extensions/index.js"),
		join(root, "dist/extensions/pi-agent-team/index.js"),
	];

	for (const modulePath of [sourceModule, compiledModule]) {
		const candidates = getOrchestratorSelfEntryPaths(modulePath);
		for (const entrypoint of expected) assert.ok(candidates.has(entrypoint), `${modulePath}: ${entrypoint}`);
	}
});

test("a source package root named dist is not mistaken for compiled output", () => {
	const parent = createLayout("pi-agent-team-dist-collision-");
	const packageRoot = join(parent, "dist");
	const sourceModule = join(packageRoot, "src/safety/self-extension.ts");
	const sourceEntry = join(packageRoot, "extensions/index.ts");
	const compiledEntry = join(packageRoot, "dist/extensions/index.js");

	for (const modulePath of [sourceModule, pathToFileURL(sourceModule).href]) {
		const candidates = getOrchestratorSelfEntryPaths(modulePath);
		assert.ok(candidates.has(sourceEntry), `${modulePath}: source entry`);
		assert.ok(candidates.has(compiledEntry), `${modulePath}: compiled entry`);
		assert.equal(isRecursiveOrchestratorExtensionSource(sourceEntry, packageRoot, modulePath), true, modulePath);
		assert.equal(
			isRecursiveOrchestratorExtensionSource(join(packageRoot, "extensions/provider.ts"), packageRoot, modulePath),
			false,
			modulePath,
		);
	}
});

test("source, built, and packed self entries are rejected while non-self extensions remain allowed", () => {
	const checkout = createLayout("pi-agent-team-checkout-");
	const packedRoot = join(checkout, "installed/node_modules/pi-agents-team");
	const cases = [
		{
			modulePath: join(checkout, "src/safety/self-extension.ts"),
			baseDir: checkout,
			sources: [
				"./extensions/index.ts",
				"./dist/extensions/index.js",
				"./dist/extensions/../extensions/pi-agent-team/index.js",
			],
		},
		{
			modulePath: join(checkout, "dist/src/safety/self-extension.js"),
			baseDir: checkout,
			sources: ["./dist/extensions/index.js", resolve(checkout, "dist/extensions/pi-agent-team/index.js")],
		},
		{
			modulePath: join(packedRoot, "dist/src/safety/self-extension.js"),
			baseDir: join(checkout, "consumer"),
			sources: [join(packedRoot, "dist/extensions/index.js"), join(packedRoot, "dist/extensions/pi-agent-team/index.js")],
		},
	];

	for (const { modulePath, baseDir, sources } of cases) {
		for (const source of sources) {
			assert.equal(isRecursiveOrchestratorExtensionSource(source, baseDir, modulePath), true, `${modulePath}: ${source}`);
		}
		assert.equal(
			isRecursiveOrchestratorExtensionSource("./extensions/custom-provider.ts", baseDir, modulePath),
			false,
			modulePath,
		);
	}
});

test("self-entry detection follows symlinks in a compiled package layout", () => {
	const root = createLayout("pi-agent-team-symlink-");
	const modulePath = join(root, "dist/src/safety/self-extension.js");
	const entrypoint = join(root, "dist/extensions/index.js");
	const consumer = join(root, "consumer");
	const linkedEntry = join(consumer, "linked-extension.js");
	mkdirSync(resolve(entrypoint, ".."), { recursive: true });
	mkdirSync(consumer, { recursive: true });
	writeFileSync(entrypoint, "export default () => {};\n");
	symlinkSync(entrypoint, linkedEntry, "file");

	assert.equal(isRecursiveOrchestratorExtensionSource(linkedEntry, consumer, modulePath), true);
	assert.equal(isRecursiveOrchestratorExtensionSource(join(consumer, "other-extension.js"), consumer, modulePath), false);
});
