import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../../src/config";
import { resolveProfile } from "../../src/profiles/loader";
import { applyLaunchPolicy } from "../../src/safety/launch-policy";
import { ensureWriteScope, isPathScopeNarrowerOrEqual, isPathWithinScope } from "../../src/safety/path-scope";
import type { TeamConfig, TeamProfileSpec } from "../../src/types";

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

test("applyLaunchPolicy rejects launch-time tool widening for read-only roles", () => {
	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: process.cwd(),
				profile: resolveProfile("reviewer"),
				tools: ["read", "edit"],
			}),
		/configured tool set/,
	);
});

test("applyLaunchPolicy rejects broader launch-time path scope than the role allows", () => {
	const profile: TeamProfileSpec = {
		...resolveProfile("fixer"),
		pathScope: {
			roots: ["src/safety"],
			allowReadOutsideRoots: false,
			allowWrite: true,
		},
	};

	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: process.cwd(),
				profile,
				pathScope: {
					roots: ["src"],
					allowReadOutsideRoots: false,
					allowWrite: true,
				},
			}),
		/cannot broaden the role's configured scope/,
	);
});

test("applyLaunchPolicy rejects prompt and scope paths outside the discovered project root", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-launch-policy-"));
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(join(root, "prompts", "reviewer.md"), "# reviewer\n");
	const config: TeamConfig = {
		...DEFAULT_TEAM_CONFIG,
		safety: {
			...DEFAULT_TEAM_CONFIG.safety,
			projectRoot: root,
		},
	};

	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: root,
				profile: resolveProfile("reviewer"),
				systemPromptPath: "../escape.md",
			}, config),
		/within the discovered project root/,
	);

	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: root,
				profile: resolveProfile("fixer"),
				pathScope: {
					roots: ["../outside"],
					allowReadOutsideRoots: false,
					allowWrite: true,
				},
			}, config),
		/within the discovered project root/,
	);
});

test("applyLaunchPolicy allows external path scopes when config opts in but still rejects prompt escapes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-launch-policy-external-"));
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(join(root, "prompts", "reviewer.md"), "# reviewer\n");
	const config: TeamConfig = {
		...DEFAULT_TEAM_CONFIG,
		safety: {
			...DEFAULT_TEAM_CONFIG.safety,
			allowWorkerPathsOutsideProject: true,
			projectRoot: root,
		},
	};

	assert.throws(
		() =>
			applyLaunchPolicy({
				cwd: root,
				profile: resolveProfile("reviewer"),
				systemPromptPath: "../escape.md",
			}, config),
		/within the discovered project root/,
	);

	const plan = applyLaunchPolicy({
		cwd: root,
		profile: resolveProfile("fixer"),
		pathScope: {
			roots: ["../outside"],
			allowReadOutsideRoots: false,
			allowWrite: true,
		},
	}, config);

	assert.deepEqual(plan.pathScope?.roots, [resolve(root, "../outside")]);
});

test("path scope helpers normalize and validate scoped paths", () => {
	const scope = ensureWriteScope(
		{ roots: ["src/runtime"], allowReadOutsideRoots: false, allowWrite: true },
		process.cwd(),
	);
	assert.equal(isPathWithinScope("src/runtime/worker-manager.ts", scope, process.cwd()), true);
	assert.equal(isPathWithinScope("README.md", scope, process.cwd()), false);
	assert.equal(
		isPathScopeNarrowerOrEqual(
			{ roots: ["src/runtime"], allowReadOutsideRoots: false, allowWrite: true },
			{ roots: ["src"], allowReadOutsideRoots: false, allowWrite: true },
			process.cwd(),
		),
		true,
	);
});
