import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerProcessArgs, resolveWorkerSpawnImplementation, spawnWorkerProcess } from "../../src/runtime/worker-process";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { HOST_PI_VERSION, type ProbeWorkerPiVersion } from "../../src/runtime/pi-version";
import { MockWorkerHandle, MockWorkerTransport } from "./test-helpers";

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

test("WorkerManager rejects an unsupported worker before RPC process launch", async () => {
	let launches = 0;
	const manager = new WorkerManager(
		() => {
			launches += 1;
			return new MockWorkerHandle(new MockWorkerTransport());
		},
		async () => ({
			command: "old-pi",
			versionArgs: ["--version"],
			hostVersion: HOST_PI_VERSION,
			minimumVersion: "0.80.6",
			workerVersion: "0.80.5",
			supported: false,
			mismatch: false,
			message: "Cannot launch Pi worker: old-pi is Pi 0.80.5, but RPC workers require Pi 0.80.6 or newer. Update the selected worker command or rpc.command.",
		}),
	);
	await assert.rejects(
		manager.launchWorker({ workerId: "old", profileName: "fixer", task: {} as any, cwd: process.cwd() }),
		/RPC workers require Pi 0\.80\.6 or newer/,
	);
	assert.equal(launches, 0);
});

test("WorkerManager injects the selected command into preflight and emits mismatch diagnostics", async () => {
	const probes: Array<{ command?: string; baseArgs?: string[] }> = [];
	const probe: ProbeWorkerPiVersion = async (options) => {
		probes.push(options);
		return {
			command: options.command ?? "pi",
			versionArgs: ["--version"],
			hostVersion: HOST_PI_VERSION,
			minimumVersion: "0.80.6",
			workerVersion: "0.81.0",
			supported: true,
			mismatch: true,
		};
	};
	const manager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()), probe);
	const warnings: string[] = [];
	manager.onPiVersionMismatch((event) => warnings.push(event.message));
	await manager.launchWorker({
		workerId: "newer",
		profileName: "fixer",
		task: {} as any,
		cwd: process.cwd(),
		command: "custom-pi",
		baseArgs: ["--mode", "rpc", "--no-session"],
	});
	assert.deepEqual(probes, [{ command: "custom-pi", baseArgs: ["--mode", "rpc", "--no-session"], cwd: process.cwd(), env: undefined }]);
	assert.deepEqual(warnings, ["Pi Agents Team: host Pi 0.80.6 is launching worker Pi 0.81.0 via custom-pi; the supported version mismatch is non-fatal."]);
	await manager.dispose();
});

test("injected worker launchers do not probe the machine-global Pi by default", async () => {
	const manager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	await manager.launchWorker({ workerId: "injected", profileName: "fixer", task: {} as any, cwd: process.cwd(), command: "custom-test-pi" });
	assert.equal(manager.hasWorker("injected"), true);
	await manager.dispose();
});

test("spawnWorkerProcess converts child_process spawn errors into waitForExit failure info", async () => {
	const handle = spawnWorkerProcess({
		cwd: process.cwd(),
		command: "pi-agent-team-definitely-missing-command-for-test",
	});

	const exitInfo = await handle.waitForExit();
	assert.equal(exitInfo.code, null);
	assert.equal(exitInfo.signal, null);
	assert.ok(exitInfo.error);
	assert.match(exitInfo.error.message, /ENOENT|not found/i);
	assert.match(handle.stderrBuffer, /ENOENT|not found/i);
});
