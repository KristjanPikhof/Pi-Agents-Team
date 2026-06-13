import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { _testing as resultTesting, registerTeamResultCommand } from "../../src/commands/team-result";
import type { WorkerRuntimeState } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";
import { stripAnsi } from "../../src/ui/theme";

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
	assert.doesNotMatch(out, /\x1b\[/, "team-result output must be ANSI-free");
	assert.match(out, new RegExp(`^reviewer \\(${delegated.worker.workerId}\\)`));
	const plain = stripAnsi(out);
	const detailSection = plain.split("--- Latest assistant text ---")[0]!;
	assert.match(detailSection, new RegExp(`^reviewer \\(${delegated.worker.workerId}\\)`));
	assert.match(detailSection, /Task: Inspect runtime/);
	assert.match(detailSection, /Result:\n/);
	assert.doesNotMatch(detailSection, /^Usage:/m);
	assert.doesNotMatch(detailSection, /^Worker:/m);
	assert.doesNotMatch(detailSection, /^Profile:/m);
	assert.doesNotMatch(detailSection, /^Goal:/m);
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

test("formatWorkerDetail suppresses usage and context metadata", () => {
	const worker: WorkerRuntimeState = {
		workerId: "w6",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 4,
			inputTokens: 1200,
			outputTokens: 2_500_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.42,
			contextTokens: 128000,
			contextWindow: 200000,
			contextPercent: 64,
			contextRemainingTokens: 72000,
		},
	};
	const text = resultTesting.formatWorkerDetail(worker, undefined);
	assert.doesNotMatch(text, /^Usage:/m);
	assert.doesNotMatch(text, /^Context:/m);
	assert.match(text, /Result:\nNo final answer block extracted yet\./);
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
	assert.doesNotMatch(text, /\x1b\[/, "team-result formatter output must be ANSI-free");
	assert.match(text, /^reviewer \(w7\)/);
	const plain = stripAnsi(text);
	assert.match(plain, /^reviewer \(w7\)/);
	assert.match(plain, /Status: idle \(Idle\)/);
	assert.match(plain, /No final answer block extracted yet/);
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /Latest assistant text/);
});

test("formatWorkerDetail prints final answer and suppresses transcript when final exists", () => {
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
	assert.match(text, /Result:\nAuthoritative worker deliverable/);
	assert.doesNotMatch(text, /Latest assistant text/);
	assert.doesNotMatch(text, /intermediate assistant tail/);
});

test("formatWorkerDetail strips raw final_answer blocks from latest assistant text", () => {
	const worker: WorkerRuntimeState = {
		workerId: "w9",
		profileName: "fixer",
		sessionMode: "worker",
		status: "completed",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		finalAnswer: "Authoritative section stays formatted.",
		pendingRelayQuestions: [],
		usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
	};
	const text = resultTesting.formatWorkerDetail(
		worker,
		"prelude\n<final_answer>\nraw duplicate transcript block\n</final_answer>",
	);

	assert.match(text, /Result:\nAuthoritative section stays formatted\./);
	assert.doesNotMatch(text, /Latest assistant text/);
	assert.doesNotMatch(text, /prelude/);
	assert.doesNotMatch(text, /raw duplicate transcript block/);
	assert.doesNotMatch(text, /<\/final_answer>$/);
});
