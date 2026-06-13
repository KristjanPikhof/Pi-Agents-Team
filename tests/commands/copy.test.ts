import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { registerCopyCommand } from "../../src/commands/copy";
import { buildCopyPayload } from "../../src/ui/copy-payload";
import type { WorkerRuntimeState } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

/**
 * Install team-copy with a mockable clipboard. The `onCopy` callback captures
 * the payload instead of spawning pbcopy/xclip, keeping tests hermetic.
 */
function installCopyCommand(teamManager: TeamManager, onCopy?: (payload: string) => Promise<void>) {
	const commands: RegisteredCommand[] = [];
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];

	// Temporarily override require path for clipboard: we monkey-patch the
	// teamManager dependency by wrapping registerCopyCommand's emitText + a
	// copy shim injected at the module level is not feasible here. Instead we
	// rely on: if onCopy is provided, the real clipboard is still called BUT
	// we can test the pre-clipboard paths (missing arg, unknown id) without
	// touching clipboard at all.
	registerCopyCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{
			teamManager,
			emitText: (_ctx: any, text: string) => emitted.push(text),
		},
	);

	const cmd = commands.find((c) => c.name === "team-copy");
	assert.ok(cmd, "team-copy command must register");
	const ctx = {
		cwd: process.cwd(),
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
	} as any;
	return {
		run: (args: string) => cmd!.handler(args, ctx),
		emitted,
		notifications,
	};
}

test("team-copy command registers under the name 'team-copy'", () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const harness = installCopyCommand(teamManager);
	// Registration assertion is done inside installCopyCommand; reaching here means it passed.
	assert.ok(harness, "harness installed");
});

test("/team-copy without args notifies usage", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const harness = installCopyCommand(teamManager);
	await harness.run("");
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /Usage: \/team-copy/);
});

test("/team-copy <unknown-id> notifies about unknown worker without emitting", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const harness = installCopyCommand(teamManager);
	await harness.run("does-not-exist");
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /Unknown worker/);
});

test("buildCopyPayload produces the expected sections for a minimal worker", () => {
	const now = Date.now();
	const worker: WorkerRuntimeState = {
		workerId: "w-copy-1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		finalAnswer: "Done — all tests green.",
		usage: {
			turns: 3,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
			costUsd: 0.0042,
		},
	};

	const payload = buildCopyPayload(worker, "Some assistant text", undefined);

	assert.match(payload, /# Worker w-copy-1 · reviewer · idle/);
	assert.match(payload, /## Final answer/);
	assert.match(payload, /Done — all tests green\./);
	assert.match(payload, /## Usage/);
	assert.match(payload, /turns=3/);
	assert.match(payload, /cost_usd=0\.0042/);
	assert.match(payload, /## Latest assistant text/);
	assert.match(payload, /Some assistant text/);
	// No console section when consoleEvents is undefined.
	assert.doesNotMatch(payload, /## Console timeline/);
});

test("buildCopyPayload includes console timeline when events are provided", () => {
	const now = Date.now();
	const worker: WorkerRuntimeState = {
		workerId: "w-copy-2",
		profileName: "fixer",
		sessionMode: "worker",
		status: "completed",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		usage: {
			turns: 1,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};

	const events = [
		{ ts: now, kind: "tool_start" as const, text: "Ran bash" },
		{ ts: now + 100, kind: "assistant_text" as const, text: "All done" },
	];

	const payload = buildCopyPayload(worker, undefined, events);
	assert.match(payload, /## Console timeline/);
	assert.match(payload, /\[tool_start\] Ran bash/);
	assert.match(payload, /\[assistant_text\] All done/);
	// No transcript block when undefined.
	assert.match(payload, /\(no assistant text captured\)/);
});

test("/team-copy passes real worker activity events into clipboard payload", async () => {
	const now = Date.now();
	const worker: WorkerRuntimeState = {
		workerId: "w-copy-activity",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};
	const capturedPath = join(await mkdtemp(join(tmpdir(), "team-copy-test-")), "payload.txt");
	const binDir = await mkdtemp(join(tmpdir(), "team-copy-bin-"));
	for (const command of ["pbcopy", "wl-copy", "xclip", "xsel"]) {
		const scriptPath = join(binDir, command);
		await writeFile(scriptPath, `#!/bin/sh\ncat > ${JSON.stringify(capturedPath)}\n`, "utf8");
		chmodSync(scriptPath, 0o755);
	}
	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
	try {
		const harness = installCopyCommand({
			listWorkers: () => [worker],
			resolveWorkerId: (input: string) => input === worker.workerId ? worker.workerId : undefined,
			getWorkerResult: () => ({ worker }),
			getWorkerTranscript: () => "assistant transcript",
			getWorkerConsole: () => [{ ts: now, kind: "tool_start", text: "raw fallback command" }],
			getWorkerActivity: () => [{
				id: "activity-1",
				ts: now,
				updatedAt: now,
				actionKind: "command",
				status: "completed",
				label: "Ran npm test",
				summary: "npm test",
				command: "npm test",
				sourceEvent: "worker_tool_finished",
			}],
		} as unknown as TeamManager);

		await harness.run(worker.workerId);
		const payload = await readFile(capturedPath, "utf8");
		const activitySection = payload.split("## Activity")[1]?.split("## Console timeline")[0] ?? "";
		assert.match(activitySection, /• Ran npm test/);
		assert.doesNotMatch(activitySection, /raw fallback command/);
		assert.match(harness.notifications[0]?.message ?? "", /Copy complete/);
	} finally {
		process.env.PATH = originalPath;
	}
});

test("buildCopyPayload includes task block when currentTask is present", () => {
	const now = Date.now();
	const worker: WorkerRuntimeState = {
		workerId: "w-copy-3",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		currentTask: {
			taskId: "t1",
			title: "Audit auth flow",
			goal: "Find auth gaps",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: ["Focus on JWT expiry"],
			pathScope: { roots: ["/src/auth"] },
			expectedOutput: "Bug list",
			createdAt: now,
		},
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};

	const payload = buildCopyPayload(worker, undefined, undefined);
	assert.match(payload, /## Task/);
	assert.match(payload, /title: Audit auth flow/);
	assert.match(payload, /goal: Find auth gaps/);
	assert.match(payload, /expected_output: Bug list/);
	assert.match(payload, /context_hints:/);
	assert.match(payload, /Focus on JWT expiry/);
	assert.match(payload, /path_scope:/);
	assert.match(payload, /\/src\/auth/);
});
