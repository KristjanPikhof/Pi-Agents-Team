import test from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { buildWorkerProcessArgs, resolveWorkerSpawnImplementation, spawnWorkerProcess, terminateWindowsWorkerTree } from "../../src/runtime/worker-process";
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

test("buildWorkerProcessArgs passes max through unchanged", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd(), thinkingLevel: "max" });

	assert.deepEqual(args, ["--mode", "rpc", "--no-session", "--thinking", "max"]);
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

test("Windows worker termination selects taskkill tree escalation and falls back on failure", async () => {
	const childSignals: Array<NodeJS.Signals | undefined> = [];
	const taskkillCalls: Array<{ command: string; args: string[] }> = [];
	const child = {
		pid: 4321,
		kill(signal?: NodeJS.Signals) {
			childSignals.push(signal);
			return true;
		},
	};
	const spawnTaskkill = (command: string, args: string[]) => {
		taskkillCalls.push({ command, args });
		const killer = new EventEmitter() as EventEmitter & { pid: number; kill(signal?: NodeJS.Signals): boolean };
		killer.pid = 9999;
		killer.kill = () => true;
		queueMicrotask(() => killer.emit("close", 1));
		return killer;
	};

	await terminateWindowsWorkerTree(child, spawnTaskkill, 50);

	assert.deepEqual(taskkillCalls, [{
		command: "taskkill",
		args: ["/pid", "4321", "/T", "/F"],
	}]);
	assert.deepEqual(childSignals, ["SIGKILL"], "failed taskkill must fall back to direct forced termination");
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
	assert.deepEqual(warnings, [
		`Pi Agents Team: host Pi ${HOST_PI_VERSION} is launching worker Pi 0.81.0 via custom-pi; the supported version mismatch is non-fatal.`,
	]);
	await manager.dispose();
});

test("WorkerManager reports max clamping once and leaves supported max unclamped", async () => {
	const clampedTransport = new MockWorkerTransport({ initialState: { thinkingLevel: "xhigh" } });
	const clampedManager = new WorkerManager(() => new MockWorkerHandle(clampedTransport));
	const clampEvents: Array<{ type: string; requested?: string; effective?: string }> = [];
	clampedManager.onEvent((_worker, event) => clampEvents.push(event));

	const clampedWorker = await clampedManager.launchWorker({
		workerId: "max-clamped",
		profileName: "fixer",
		task: {} as any,
		cwd: process.cwd(),
		model: "provider/limited-model",
		thinkingLevel: "max",
	});
	await clampedManager.refreshState("max-clamped");

	assert.equal(clampedWorker.state.requestedThinkingLevel, "max");
	assert.equal(clampedWorker.state.effectiveThinkingLevel, "xhigh");
	assert.deepEqual(
		clampEvents.filter((event) => event.type === "thinking_clamped").map(({ requested, effective }) => ({ requested, effective })),
		[{ requested: "max", effective: "xhigh" }],
	);
	await clampedManager.dispose();

	const supportedTransport = new MockWorkerTransport({ initialState: { thinkingLevel: "max" } });
	const supportedManager = new WorkerManager(() => new MockWorkerHandle(supportedTransport));
	const supportedEvents: string[] = [];
	supportedManager.onEvent((_worker, event) => supportedEvents.push(event.type));
	const supportedWorker = await supportedManager.launchWorker({
		workerId: "max-supported",
		profileName: "fixer",
		task: {} as any,
		cwd: process.cwd(),
		thinkingLevel: "max",
	});

	assert.equal(supportedWorker.state.requestedThinkingLevel, "max");
	assert.equal(supportedWorker.state.effectiveThinkingLevel, "max");
	assert.equal(supportedEvents.filter((type) => type === "thinking_clamped").length, 0);
	await supportedManager.dispose();
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

test("POSIX disposal terminates the worker process group including child and grandchild", {
	skip: process.platform === "win32",
	timeout: 5_000,
}, async () => {
	const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
	const childSource = [
		"const { spawn } = require('node:child_process');",
		"process.on('SIGTERM', () => {});",
		`const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
		"console.log(JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
		"setInterval(() => {}, 1000);",
	].join("");
	const workerSource = [
		"const { spawn } = require('node:child_process');",
		"process.on('SIGTERM', () => {});",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
		"console.log(JSON.stringify({ worker: process.pid, child: child.pid }));",
		"setInterval(() => {}, 1000);",
	].join("");
	const handle = spawnWorkerProcess({
		cwd: process.cwd(),
		command: process.execPath,
		baseArgs: ["-e", workerSource],
	});
	let output = "";
	const pids = new Set<number>();
	const ready = Promise.withResolvers<void>();
	handle.transport.stdout.on("data", (chunk) => {
		output += chunk.toString();
		for (const line of output.trim().split("\n")) {
			try {
				const parsed = JSON.parse(line) as { worker?: number; child?: number; grandchild?: number };
				for (const pid of [parsed.worker, parsed.child, parsed.grandchild]) {
					if (typeof pid === "number") pids.add(pid);
				}
			} catch {
				// Wait for a complete JSON line.
			}
		}
		if (pids.size === 3) ready.resolve();
	});
	await ready.promise;

	const disposeStartedAt = Date.now();
	await handle.dispose();
	assert.ok(Date.now() - disposeStartedAt < 1_500, "tree disposal must settle within its grace and exit bounds");

	const deadline = Date.now() + 1_500;
	while (Date.now() < deadline) {
		const survivors = [...pids].filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
		if (survivors.length === 0) return;
		// This integration assertion observes real kernel process reaping; fake
		// timers cannot advance an OS process from live/zombie to gone.
		await delay(20);
	}
	assert.fail(`process tree survivors after disposal: ${[...pids].join(", ")}`);
});
