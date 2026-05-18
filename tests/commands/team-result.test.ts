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
	assert.match(out, new RegExp(`^\\x1b\\[1mreviewer\\x1b\\[0m \\(${delegated.worker.workerId}\\)`));
	const plain = stripAnsi(out);
	assert.match(plain, new RegExp(`^reviewer \\(${delegated.worker.workerId}\\)`));
	assert.match(plain, /Task: Inspect runtime/);
	assert.match(plain, /Usage: turns=/);
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /^Profile:/m);
	assert.doesNotMatch(plain, /^Goal:/m);
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

test("formatWorkerDetail uses compact token counts and context budget for scanned terminal display", () => {
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
	assert.match(text, /Usage: turns=4 input=1\.2k output=2\.5m cost=\$0\.4200/);
	assert.match(text, /Context: ctx=64%\/200k rem=72k/);
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
	assert.match(text, /^\x1b\[1mreviewer\x1b\[0m \(w7\)/);
	const plain = stripAnsi(text);
	assert.match(plain, /^reviewer \(w7\)/);
	assert.match(plain, /Status: idle \(Idle\)/);
	assert.match(plain, /No <final_answer> block extracted yet/);
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /Latest assistant text/);
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

	assert.match(text, /--- Final answer \(from worker's <final_answer> block\) ---\nAuthoritative section stays formatted\./);
	assert.match(text, /--- Latest assistant text ---\nprelude$/);
	assert.doesNotMatch(text, /raw duplicate transcript block/);
	assert.doesNotMatch(text, /<\/final_answer>$/);
});
