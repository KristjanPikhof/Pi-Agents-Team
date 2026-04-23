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

test("worker_state keeps a starting worker as starting when isStreaming is false", async () => {
	const transport = new MockWorkerTransport();
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	const worker = await manager.launchWorker({
		workerId: "worker-guard-1",
		profileName: "reviewer",
		task: {
			taskId: "task-guard-1",
			title: "Guard check",
			goal: "Verify the starting-state guard",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	assert.equal(worker.state.status, "starting");

	await manager.refreshState("worker-guard-1");
	const after = manager.getWorker("worker-guard-1");
	assert.equal(after?.state.status, "starting");
});

test("promptWorker marks rejected prompt acceptance as error", async () => {
	const transport = new MockWorkerTransport({ rejectPrompt: "prompt rejected by rpc" });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-reject-1",
		profileName: "reviewer",
		task: {
			taskId: "task-reject-1",
			title: "Prompt rejection",
			goal: "Verify rejected prompt acceptance state",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});

	await assert.rejects(
		() => manager.promptWorker("worker-reject-1", "do the thing"),
		/prompt rejected by rpc/,
	);

	const worker = manager.getWorker("worker-reject-1");
	assert.equal(worker?.state.status, "error");
	assert.match(worker?.state.error ?? "", /prompt rejected by rpc/);
	assert.notEqual(worker?.state.status, "running");
});

test("worker_state transitions a non-starting worker based on isStreaming", async () => {
	const transport = new MockWorkerTransport();
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-transition-1",
		profileName: "reviewer",
		task: {
			taskId: "task-transition-1",
			title: "Transition check",
			goal: "Verify non-starting workers transition via worker_state",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});

	await manager.promptWorker("worker-transition-1", "do the thing");
	await waitForMicrotasks();
	await waitForMicrotasks();

	const afterComplete = manager.getWorker("worker-transition-1");
	assert.equal(afterComplete?.state.status, "idle");

	transport.setState({ isStreaming: true });
	await manager.refreshState("worker-transition-1");
	const afterUpgrade = manager.getWorker("worker-transition-1");
	assert.equal(afterUpgrade?.state.status, "running");

	transport.setState({ isStreaming: false });
	await manager.refreshState("worker-transition-1");
	const afterDowngrade = manager.getWorker("worker-transition-1");
	assert.equal(afterDowngrade?.state.status, "idle");
});

test("applyNormalizedEvent captures <final_answer> contents on message_end", async () => {
	const finalAnswerBody = "headline: guard regression verified\nfiles:\n- src/runtime/worker-manager.ts";
	const transport = new MockWorkerTransport({
		promptText: `some chatter\n<final_answer>\n${finalAnswerBody}\n</final_answer>\ntrailing`,
	});
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-final-1",
		profileName: "reviewer",
		task: {
			taskId: "task-final-1",
			title: "Final answer capture",
			goal: "Populate finalAnswer from the message_end event",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});

	await manager.promptWorker("worker-final-1", "deliver the final answer");
	await waitForMicrotasks();
	await waitForMicrotasks();

	const worker = manager.getWorker("worker-final-1");
	assert.ok(worker?.state.finalAnswer);
	assert.match(worker!.state.finalAnswer!, /headline: guard regression verified/);
	assert.match(worker!.state.finalAnswer!, /src\/runtime\/worker-manager\.ts/);
	assert.doesNotMatch(worker!.state.finalAnswer!, /trailing/);
	assert.doesNotMatch(worker!.state.finalAnswer!, /some chatter/);
});
