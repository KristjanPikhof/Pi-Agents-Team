import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { _testing as resultTesting, registerTeamResultCommand } from "../../src/commands/team-result";
import type { WorkerRuntimeState } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installTeamResultCommand(teamManager: TeamManager) {
	const commands: RegisteredCommand[] = [];
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	registerTeamResultCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{
			teamManager,
			emitText: (_ctx, text) => emitted.push(text),
		},
	);
	const cmd = commands.find((c) => c.name === "team-result");
	assert.ok(cmd, "team-result command must register");
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

test("/team-result <id> emits the formatted worker detail for a known worker", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Inspect runtime",
		goal: "Verify runtime regressions",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await waitForMicrotasks();

	const harness = installTeamResultCommand(teamManager);
	await harness.run(delegated.worker.workerId);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.emitted.length, 1);
	const out = harness.emitted[0]!;
	assert.match(out, new RegExp(`Worker: ${delegated.worker.workerId}`));
	assert.match(out, /Profile: reviewer/);
	assert.match(out, /Status:/);
	assert.match(out, /Task: Inspect runtime/);
	assert.match(out, /Goal:/);
	assert.match(out, /Usage: turns=/);
});

test("/team-result with an unknown id notifies and does not emit", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const harness = installTeamResultCommand(teamManager);
	await harness.run("does-not-exist");

	assert.equal(harness.emitted.length, 0);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!.message, /Unknown worker/);
});

test("/team-result without an id notifies usage", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const harness = installTeamResultCommand(teamManager);
	await harness.run("");

	assert.equal(harness.emitted.length, 0);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!.message, /Usage: \/team-result/);
});

test("formatWorkerDetail without transcript renders the placeholder line (parity with inline agent-result)", () => {
	const worker: WorkerRuntimeState = {
		workerId: "w7",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
	};
	const text = resultTesting.formatWorkerDetail(worker, undefined);
	assert.match(text, /Worker: w7/);
	assert.match(text, /No <final_answer> block extracted yet/);
	assert.doesNotMatch(text, /Latest assistant text/);
});

test("formatWorkerDetail prints the final answer before latest assistant text", () => {
	const worker: WorkerRuntimeState = {
		workerId: "w8",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		finalAnswer: "Authoritative worker deliverable.",
		pendingRelayQuestions: [],
		usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
	};
	const text = resultTesting.formatWorkerDetail(worker, "intermediate assistant tail");
	const finalIndex = text.indexOf("--- Final answer");
	const transcriptIndex = text.indexOf("--- Latest assistant text");
	assert.ok(finalIndex >= 0, "expected final answer section");
	assert.ok(transcriptIndex > finalIndex, "expected transcript after final answer");
	assert.match(text, /Authoritative worker deliverable/);
	assert.match(text, /intermediate assistant tail/);
});
