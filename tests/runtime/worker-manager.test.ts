import test from "node:test";
import assert from "node:assert/strict";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "./test-helpers";

function taskInput(taskId: string, title: string, profileName = "reviewer") {
	return {
		taskId,
		title,
		goal: title,
		requestedBy: "orchestrator" as const,
		profileName,
		cwd: process.cwd(),
		contextHints: [],
		createdAt: Date.now(),
	};
}

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

test("launchWorker keeps matching RPC thinking level without clamp event", async () => {
	const transport = new MockWorkerTransport({ initialState: { thinkingLevel: "high" } });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	const events: string[] = [];
	const off = manager.onEvent((_worker, event) => {
		events.push(event.type);
	});

	const worker = await manager.launchWorker({
		workerId: "worker-thinking-match",
		profileName: "reviewer",
		task: taskInput("task-thinking-match", "Thinking match"),
		cwd: process.cwd(),
		thinkingLevel: "high",
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	off();

	assert.equal(worker.state.requestedThinkingLevel, "high");
	assert.equal(worker.state.effectiveThinkingLevel, "high");
	assert.ok(!events.includes("thinking_clamped"));
});

test("launchWorker emits thinking_clamped when RPC effective thinking level differs", async () => {
	const transport = new MockWorkerTransport({ initialState: { thinkingLevel: "low" } });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	const clampEvents: unknown[] = [];
	const off = manager.onEvent((_worker, event) => {
		if (event.type === "thinking_clamped") clampEvents.push(event);
	});

	const worker = await manager.launchWorker({
		workerId: "worker-thinking-clamped",
		profileName: "fixer",
		task: taskInput("task-thinking-clamped", "Thinking clamp", "fixer"),
		cwd: process.cwd(),
		model: "gpt-test",
		thinkingLevel: "high",
		tools: ["read", "bash"],
		extensionMode: "worker-minimal",
	});
	off();

	assert.equal(worker.state.requestedThinkingLevel, "high");
	assert.equal(worker.state.effectiveThinkingLevel, "low");
	assert.equal(clampEvents.length, 1);
	assert.deepEqual(clampEvents[0], {
		type: "thinking_clamped",
		workerId: "worker-thinking-clamped",
		profileName: "fixer",
		modelLabel: "gpt-test",
		requested: "high",
		effective: "low",
		timestamp: (clampEvents[0] as { timestamp: number }).timestamp,
	});
	assert.equal(typeof (clampEvents[0] as { timestamp: unknown }).timestamp, "number");
});

test("launchWorker ignores unrecognized RPC thinking level and keeps requested value", async () => {
	const transport = new MockWorkerTransport({ initialState: { thinkingLevel: "surprise" } });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	const events: string[] = [];
	const off = manager.onEvent((_worker, event) => {
		events.push(event.type);
	});

	const worker = await manager.launchWorker({
		workerId: "worker-thinking-unknown",
		profileName: "reviewer",
		task: taskInput("task-thinking-unknown", "Unknown thinking"),
		cwd: process.cwd(),
		thinkingLevel: "medium",
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	off();

	assert.equal(worker.state.requestedThinkingLevel, "medium");
	assert.equal(worker.state.effectiveThinkingLevel, "medium");
	assert.ok(!events.includes("thinking_clamped"));
});

test("reuseWorker does not re-check thinking clamp state", async () => {
	const transport = new MockWorkerTransport({
		initialState: { thinkingLevel: "high" },
		promptText: "<final_answer>headline: done</final_answer>",
	});
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	const events: string[] = [];
	const off = manager.onEvent((_worker, event) => {
		events.push(event.type);
	});

	await manager.launchWorker({
		workerId: "worker-thinking-reuse",
		profileName: "reviewer",
		task: taskInput("task-thinking-reuse-1", "First thinking task"),
		cwd: process.cwd(),
		thinkingLevel: "high",
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-thinking-reuse", "first");
	await waitForMicrotasks();
	await waitForMicrotasks();

	transport.setState({ thinkingLevel: "low" });
	await manager.reuseWorker("worker-thinking-reuse", "second", taskInput("task-thinking-reuse-2", "Second thinking task"));
	await waitForMicrotasks();
	await waitForMicrotasks();
	off();

	assert.equal(events.filter((type) => type === "thinking_clamped").length, 0);
	assert.equal(manager.getWorker("worker-thinking-reuse")?.state.effectiveThinkingLevel, "high");
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

test("reuseWorker resets per-task state, sends a fresh prompt, and emits a state event", async () => {
	const transports: MockWorkerTransport[] = [];
	const manager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({
			promptText: "<final_answer>headline: first run</final_answer>",
		});
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});

	await manager.launchWorker({
		workerId: "worker-reuse-1",
		profileName: "reviewer",
		task: {
			taskId: "task-reuse-1",
			title: "First task",
			goal: "Do the first thing",
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

	await manager.promptWorker("worker-reuse-1", "first prompt");
	await waitForMicrotasks();
	await waitForMicrotasks();

	const afterFirst = manager.getWorker("worker-reuse-1");
	assert.equal(afterFirst?.state.status, "idle");
	assert.match(afterFirst?.state.finalAnswer ?? "", /first run/);
	const firstCommandCount = transports[0]?.commands.length ?? 0;

	const events: string[] = [];
	const off = manager.onEvent((_worker, event) => {
		events.push(event.type);
	});

	await manager.reuseWorker("worker-reuse-1", "second prompt", {
		taskId: "task-reuse-2",
		title: "Second task",
		goal: "Do the second thing",
		requestedBy: "orchestrator",
		profileName: "reviewer",
		cwd: process.cwd(),
		contextHints: [],
		createdAt: Date.now(),
	});
	await waitForMicrotasks();
	await waitForMicrotasks();
	off();

	const afterReuse = manager.getWorker("worker-reuse-1");
	assert.equal(afterReuse?.state.status, "idle");
	assert.equal(afterReuse?.state.currentTask?.taskId, "task-reuse-2");
	assert.equal(afterReuse?.state.currentTask?.title, "Second task");
	const promptCommands = transports[0]?.commands.filter((cmd) => cmd.type === "prompt") ?? [];
	assert.equal(promptCommands.length, 2);
	assert.equal(promptCommands.at(-1)?.message, "second prompt");
	assert.ok(events.includes("worker_running"));
	assert.ok((transports[0]?.commands.length ?? 0) > firstCommandCount);
});

test("reuseWorker rejects targets that are not idle or waiting_followup", async () => {
	const manager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	await manager.launchWorker({
		workerId: "worker-reuse-running",
		profileName: "reviewer",
		task: {
			taskId: "task-reuse-running",
			title: "Stays running",
			goal: "stay running",
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
	await manager.promptWorker("worker-reuse-running", "first");
	await waitForMicrotasks();

	await assert.rejects(
		() => manager.reuseWorker("worker-reuse-running", "second", {
			taskId: "task-reuse-x",
			title: "x",
			goal: "x",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		}),
		/cannot be reused/i,
	);
});

test("closeWorker disposes the live RPC and marks the worker exited (not aborted)", async () => {
	const transport = new MockWorkerTransport();
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-close-1",
		profileName: "reviewer",
		task: {
			taskId: "task-close-1",
			title: "Close test",
			goal: "Verify close",
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
	await manager.promptWorker("worker-close-1", "do work");
	await waitForMicrotasks();
	await waitForMicrotasks();
	assert.equal(manager.getWorker("worker-close-1")?.state.status, "idle");

	await manager.closeWorker("worker-close-1");
	await waitForMicrotasks();

	const closed = manager.getWorker("worker-close-1");
	assert.equal(closed?.state.status, "exited");
	assert.match(closed?.state.error ?? "", /closed by operator/i);
});

test("closeWorker rejects running workers", async () => {
	const manager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	await manager.launchWorker({
		workerId: "worker-close-running",
		profileName: "reviewer",
		task: {
			taskId: "task-close-running",
			title: "Running",
			goal: "stay running",
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
	await manager.promptWorker("worker-close-running", "go");
	await waitForMicrotasks();

	await assert.rejects(
		() => manager.closeWorker("worker-close-running"),
		/cannot be closed/i,
	);
});

test("assistant ring buffer records text deltas, emits chunk events, and respects from-index", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-buffer-1",
		profileName: "reviewer",
		task: {
			taskId: "task-buffer-1",
			title: "Buffer test",
			goal: "Verify ring buffer",
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

	const observed: Array<{ workerId: string; index: number; text: string }> = [];
	const off = manager.onAssistantChunk((workerId, chunk) => {
		observed.push({ workerId, index: chunk.index, text: chunk.text });
	});

	await manager.promptWorker("worker-buffer-1", "first");
	await waitForMicrotasks();
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "alpha " } });
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "beta " } });
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "gamma" } });
	await waitForMicrotasks();
	off();

	const all = manager.getAssistantTail("worker-buffer-1");
	assert.ok(all.length >= 4);
	const texts = all.map((chunk) => chunk.text).join("");
	assert.match(texts, /alpha beta gamma/);
	for (let i = 1; i < all.length; i += 1) {
		assert.equal(all[i].index, all[i - 1].index + 1, "expected monotonic indexes");
	}

	const tail = manager.getAssistantTail("worker-buffer-1", all[all.length - 2].index);
	assert.equal(tail.length, 2);
	assert.equal(tail[0].index, all[all.length - 2].index);
	assert.ok(observed.length >= 4);
	assert.equal(observed[0].workerId, "worker-buffer-1");
});

test("assistant ring buffer keeps a single oversized chunk rather than self-evicting", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-buffer-big",
		profileName: "reviewer",
		task: {
			taskId: "task-buffer-big",
			title: "Oversized chunk",
			goal: "Verify single-chunk preservation",
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

	await manager.promptWorker("worker-buffer-big", "go");
	await waitForMicrotasks();
	const huge = "x".repeat(300 * 1024);
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: huge } });
	await waitForMicrotasks();

	const chunks = manager.getAssistantTail("worker-buffer-big");
	assert.equal(chunks.length, 1, "oversized single chunk must be preserved");
	assert.equal(chunks[0].text.length, huge.length);
});

test("assistant ring buffer accepts a newline-heavy chunk without bypassing the byte cap", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-buffer-newlines",
		profileName: "reviewer",
		task: {
			taskId: "task-buffer-newlines",
			title: "Newline chunk",
			goal: "Verify chunk-cap semantics under newline-heavy delta",
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

	await manager.promptWorker("worker-buffer-newlines", "go");
	await waitForMicrotasks();
	const newlineHeavy = "x\n".repeat(2000) + "tail";
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: newlineHeavy } });
	await waitForMicrotasks();

	const chunks = manager.getAssistantTail("worker-buffer-newlines");
	const totalBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
	assert.ok(totalBytes <= 256 * 1024, `byte cap must hold even when one chunk has 2000 newlines, got ${totalBytes}`);
	assert.ok(chunks.some((chunk) => chunk.text.includes("\n")), "chunk should preserve newlines as delivered");
});

test("assistant ring buffer caps line and byte budget", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-buffer-cap",
		profileName: "reviewer",
		task: {
			taskId: "task-buffer-cap",
			title: "Cap test",
			goal: "Verify cap",
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

	await manager.promptWorker("worker-buffer-cap", "go");
	await waitForMicrotasks();
	const big = "x".repeat(1024);
	for (let i = 0; i < 300; i += 1) {
		transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: big } });
	}
	await waitForMicrotasks();

	const chunks = manager.getAssistantTail("worker-buffer-cap");
	const totalBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
	assert.ok(totalBytes <= 256 * 1024, `expected byte cap respected, got ${totalBytes}`);
	assert.ok(chunks.length <= 4096, `expected chunk cap respected, got ${chunks.length}`);
	const last = chunks[chunks.length - 1];
	assert.ok(last.index >= 299, `expected monotonic indexes preserved across cap, last=${last.index}`);
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
