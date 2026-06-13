import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerProcessArgs, resolveWorkerSpawnImplementation } from "../../src/runtime/worker-process";

test("buildWorkerProcessArgs maps trusted project decision to --approve", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd(), projectTrust: "approve" });
	assert.ok(args.includes("--approve"));
	assert.ok(!args.includes("--no-approve"));
});

test("buildWorkerProcessArgs maps untrusted project decision to --no-approve", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd(), projectTrust: "no-approve" });
	assert.ok(args.includes("--no-approve"));
	assert.ok(!args.includes("--approve"));
});

test("buildWorkerProcessArgs omits project trust flags when decision is unknown", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd() });
	assert.ok(!args.includes("--approve"));
	assert.ok(!args.includes("--no-approve"));
});

test("buildWorkerProcessArgs preserves configured base args before launch flags", () => {
	const args = buildWorkerProcessArgs({
		cwd: process.cwd(),
		baseArgs: ["node", "dist/cli.js", "--mode", "rpc", "--no-session"],
		projectTrust: "approve",
		model: "provider/model",
	});

	assert.deepEqual(args.slice(0, 5), ["node", "dist/cli.js", "--mode", "rpc", "--no-session"]);
	assert.deepEqual(args.slice(5), ["--approve", "--model", "provider/model"]);
});

test("buildWorkerProcessArgs keeps complete launch option order stable", () => {
	const args = buildWorkerProcessArgs({
		cwd: process.cwd(),
		baseArgs: ["dist/cli.js", "--mode", "rpc", "--no-session"],
		projectTrust: "approve",
		model: "provider/model",
		thinkingLevel: "high",
		tools: ["read", "grep"],
		systemPromptPath: "/tmp/worker-prompt.md",
		extensionMode: "worker-minimal",
		workerExtensions: ["npm:@org/pi-provider", "/tmp/provider.ts"],
		extraArgs: ["--append-system-prompt", "/tmp/extra-prompt.md"],
	});

	assert.deepEqual(args, [
		"dist/cli.js",
		"--mode",
		"rpc",
		"--no-session",
		"--approve",
		"--model",
		"provider/model",
		"--thinking",
		"high",
		"--tools",
		"read,grep",
		"--append-system-prompt",
		"/tmp/worker-prompt.md",
		"--no-extensions",
		"--extension",
		"npm:@org/pi-provider",
		"--extension",
		"/tmp/provider.ts",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-skills",
		"--append-system-prompt",
		"/tmp/extra-prompt.md",
	]);
});

test("buildWorkerProcessArgs keeps worker-minimal resources reduced while loading explicit extensions", () => {
	const args = buildWorkerProcessArgs({
		cwd: process.cwd(),
		extensionMode: "worker-minimal",
		workerExtensions: ["npm:@org/pi-provider", "/tmp/provider.ts"],
	});

	assert.deepEqual(args, [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--extension",
		"npm:@org/pi-provider",
		"--extension",
		"/tmp/provider.ts",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-skills",
	]);
});

test("buildWorkerProcessArgs ignores explicit extensions in disable mode", () => {
	const args = buildWorkerProcessArgs({
		cwd: process.cwd(),
		extensionMode: "disable",
		workerExtensions: ["npm:@org/pi-provider"],
	});

	assert.ok(args.includes("--no-extensions"));
	assert.ok(!args.includes("--extension"));
	assert.ok(args.includes("--no-skills"));
});

test("resolveWorkerSpawnImplementation uses cross-spawn on Windows", () => {
	assert.equal(resolveWorkerSpawnImplementation("win32"), "cross-spawn");
	assert.equal(resolveWorkerSpawnImplementation("darwin"), "node:child_process");
	assert.equal(resolveWorkerSpawnImplementation("linux"), "node:child_process");
});
