import test from "node:test";
import assert from "node:assert/strict";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "./test-helpers";

test("WorkerManager launches a worker, prompts it, and tracks compact state", async () => {
	const transports: MockWorkerTransport[] = [];
	const manager = new WorkerManager((options) => {
		const transport = new MockWorkerTransport({
			initialState: { sessionId: `worker-${transports.length + 1}` },
		});
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});

	const worker = await manager.launchWorker({
		workerId: "worker-1",
		profileName: "fixer",
		task: {
			taskId: "task-1",
			title: "Implement runtime",
			goal: "Build the RPC runtime layer",
			requestedBy: "orchestrator",
			profileName: "fixer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		cwd: process.cwd(),
		tools: ["read", "bash"],
		extensionMode: "worker-minimal",
	});

	assert.equal(worker.state.status, "starting");

	await manager.promptWorker("worker-1", "build the runtime layer");
	await waitForMicrotasks();
	await waitForMicrotasks();

	const updatedWorker = manager.getWorker("worker-1");
	assert.ok(updatedWorker);
	assert.equal(updatedWorker.state.status, "idle");
	assert.match(updatedWorker.state.lastSummary?.headline ?? "", /Completed build the runtime layer/);
	assert.equal(updatedWorker.state.usage.turns, 1);

	await manager.steerWorker("worker-1", "focus on transport");
	assert.equal(transports[0]?.commands.at(-1)?.type, "steer");

	await manager.followUpWorker("worker-1", "summarize risks next");
	assert.equal(transports[0]?.commands.at(-1)?.type, "follow_up");

	await manager.refreshStats("worker-1");
	const withStats = manager.getWorker("worker-1");
	assert.equal(withStats?.state.usage.inputTokens, 10);
	assert.equal(withStats?.state.usage.costUsd, 0.01);

	await manager.abortWorker("worker-1");
	const abortedWorker = manager.getWorker("worker-1");
	assert.equal(abortedWorker?.state.status, "aborted");
});

test("extractFinalAnswer pulls content from <final_answer> tag", async () => {
	const { extractFinalAnswer } = await import("../../src/runtime/worker-manager");
	const text = "preamble thinking\n<final_answer>\nheadline: done\nfindings:\n- x\n</final_answer>\ntrailing notes";
	const result = extractFinalAnswer(text);
	assert.ok(result);
	assert.match(result!, /headline: done/);
	assert.match(result!, /findings:/);
	assert.doesNotMatch(result!, /trailing notes/);
	assert.doesNotMatch(result!, /preamble/);
});

test("extractFinalAnswer returns undefined when tag missing", async () => {
	const { extractFinalAnswer } = await import("../../src/runtime/worker-manager");
	assert.equal(extractFinalAnswer("just some text with no tags"), undefined);
	assert.equal(extractFinalAnswer("<final_answer></final_answer>"), undefined);
});
