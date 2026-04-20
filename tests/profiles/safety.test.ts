import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../src/profiles/loader";
import { applyLaunchPolicy } from "../../src/safety/launch-policy";
import { ensureWriteScope, isPathWithinScope } from "../../src/safety/path-scope";

test("applyLaunchPolicy blocks recursive orchestrator inheritance", () => {
	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: process.cwd(),
				profile: resolveProfile("reviewer"),
				extensionMode: "inherit",
			}),
		/Recursive orchestrator launches are blocked/,
	);
});

test("applyLaunchPolicy requires writable path scope for fixer", () => {
	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: process.cwd(),
				profile: resolveProfile("fixer"),
			}),
		/explicit writable path scope/,
	);
});

test("path scope helpers normalize and validate scoped paths", () => {
	const scope = ensureWriteScope(
		{ roots: ["src/runtime"], allowReadOutsideRoots: false, allowWrite: true },
		process.cwd(),
	);
	assert.equal(isPathWithinScope("src/runtime/worker-manager.ts", scope, process.cwd()), true);
	assert.equal(isPathWithinScope("README.md", scope, process.cwd()), false);
});
