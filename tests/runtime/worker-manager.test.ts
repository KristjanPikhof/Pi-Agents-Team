import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { WorkerManager } from "../../src/runtime/worker-manager";
import type { ExitInfo, WorkerProcessHandle, WorkerTransport } from "../../src/runtime/worker-process";
import { createDefaultTeamState } from "../../src/config";
import { buildTeamWidgetLines } from "../../src/ui/status-widget";
import { stripAnsi } from "../../src/ui/theme";
import type { WorkerStatus } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "./test-helpers";

function setRuntimeStatus(
	manager: WorkerManager,
	workerId: string,
	status: WorkerStatus,
	lastEventAt: number,
): void {
	const record = (manager as unknown as {
		workers: Map<string, { state: { status: WorkerStatus; lastEventAt: number; error?: string } }>;
	}).workers.get(workerId);
	assert.ok(record, `expected runtime record for ${workerId}`);
	record.state.status = status;
	record.state.lastEventAt = lastEventAt;
	if (status === "error") record.state.error = "stale failure";
}

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

async function launchRuntimeTestWorker(workerId: string, transport: MockWorkerTransport): Promise<WorkerManager> {
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	await manager.launchWorker({
		workerId,
		profileName: "reviewer",
		task: taskInput(`task-${workerId}`, `Lifecycle ${workerId}`),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	return manager;
}

class FailingLaunchTransport extends EventEmitter implements WorkerTransport {
	readonly stdin = new Writable({
		write(_chunk, _encoding, callback) {
			callback(new Error("spawn ENOENT"));
		},
	});
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = undefined;

	constructor() {
		super();
		this.stdin.on("error", () => {
			// Expected for this launch-failure test double.
		});
	}

	kill(): boolean {
		queueMicrotask(() => this.emit("exit", null, null));
		return false;
	}
}

class FailingLaunchHandle implements WorkerProcessHandle {
	readonly transport = new FailingLaunchTransport();
	readonly pid = undefined;
	readonly stderrBuffer = "spawn ENOENT";
	private readonly spawnError = new Error("spawn ENOENT");
	private readonly exitPromise: Promise<ExitInfo> = Promise.resolve({
		code: null,
		signal: null,
		error: this.spawnError,
	});

	waitForExit(): Promise<ExitInfo> {
		return this.exitPromise;
	}

	kill(): boolean {
		return this.transport.kill();
	}

	dispose(): Promise<ExitInfo> {
		this.kill();
		return this.exitPromise;
	}
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
	transports[0]?.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();

	const updatedWorker = manager.getWorker("worker-1");
	assert.ok(updatedWorker);
	assert.equal(updatedWorker.state.status, "idle");
	assert.match(updatedWorker.state.lastSummary?.headline ?? "", /Completed build the runtime layer/);
	assert.equal(updatedWorker.state.usage.turns, 1);
	assert.equal(updatedWorker.state.usage.contextTokens, 15);
	assert.equal(updatedWorker.state.usage.contextWindow, undefined);
	assert.equal(updatedWorker.state.usage.contextPercent, undefined);
	assert.equal(updatedWorker.state.usage.contextRemainingTokens, undefined);

	await manager.steerWorker("worker-1", "focus on transport");
	assert.equal(transports[0]?.commands.at(-1)?.type, "steer");

	await manager.followUpWorker("worker-1", "summarize risks next");
	assert.equal(transports[0]?.commands.at(-1)?.type, "follow_up");

	await manager.refreshStats("worker-1");
	const withStats = manager.getWorker("worker-1");
	assert.equal(withStats?.state.usage.inputTokens, 10);
	assert.equal(withStats?.state.usage.costUsd, 0.01);
	assert.equal(withStats?.state.usage.contextTokens, 15);
	assert.equal(withStats?.state.usage.contextWindow, 200000);
	assert.equal(withStats?.state.usage.contextPercent, 0.01);
	assert.equal(withStats?.state.usage.contextRemainingTokens, 199985);

	await manager.abortWorker("worker-1");
	const abortedWorker = manager.getWorker("worker-1");
	assert.equal(abortedWorker?.state.status, "aborted");
});

test("agent_end, compaction, retries, queued continuations, and refresh stay running until one settlement", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = await launchRuntimeTestWorker("worker-settlement", transport);
	const events: string[] = [];
	manager.onEvent((_worker, event) => events.push(event.type));

	await manager.promptWorker("worker-settlement", "finish after retries");
	await waitForMicrotasks();
	transport.completePrompt("<final_answer>headline: output ready</final_answer>");
	await waitForMicrotasks();
	assert.equal(manager.getWorker("worker-settlement")?.state.status, "running");
	assert.match(manager.getWorker("worker-settlement")?.state.finalAnswer ?? "", /output ready/);
	assert.ok(events.includes("worker_agent_end"));
	assert.equal(events.filter((type) => type === "worker_idle").length, 0);

	transport.setState({ isStreaming: false, isCompacting: true });
	await manager.refreshState("worker-settlement");
	assert.equal(manager.getWorker("worker-settlement")?.state.status, "running");
	assert.equal((manager.getWorker("worker-settlement")?.state as Record<string, unknown>).awaitingSettlement, undefined);
	transport.setState({ isCompacting: false });

	transport.writeEvent({ type: "agent_start" });
	transport.writeEvent({ type: "agent_end", messages: [] });
	transport.writeEvent({ type: "queue_update", steering: [], followUp: ["continue"] });
	transport.writeEvent({ type: "agent_start" });
	transport.writeEvent({ type: "agent_end", messages: [] });
	await waitForMicrotasks();
	assert.equal(manager.getWorker("worker-settlement")?.state.status, "running");

	transport.writeEvent({ type: "agent_settled" });
	transport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(manager.getWorker("worker-settlement")?.state.status, "idle");
	assert.equal(events.filter((type) => type === "worker_idle").length, 1);
});

test("abort, RPC parse error, exit, and prompt rejection take precedence over late settlement", async () => {
	let abortTransport!: MockWorkerTransport;
	abortTransport = new MockWorkerTransport({
		autoCompletePrompt: false,
		onCommand(command) {
			// Pi 0.80.6 emits settlement before acknowledging the abort RPC.
			if (command.type === "abort") abortTransport.writeEvent({ type: "agent_settled" });
		},
	});
	const abortManager = await launchRuntimeTestWorker("worker-late-abort", abortTransport);
	const abortEvents: string[] = [];
	abortManager.onEvent((_worker, event) => abortEvents.push(event.type));
	await abortManager.promptWorker("worker-late-abort", "abort me");
	await abortManager.abortWorker("worker-late-abort");
	await waitForMicrotasks();
	assert.equal(abortManager.getWorker("worker-late-abort")?.state.status, "aborted");
	assert.equal(abortEvents.filter((type) => type === "worker_idle").length, 0);

	const errorTransport = new MockWorkerTransport({ autoCompletePrompt: false });
	const errorManager = await launchRuntimeTestWorker("worker-late-error", errorTransport);
	const errorEvents: string[] = [];
	errorManager.onEvent((_worker, event) => errorEvents.push(event.type));
	await errorManager.promptWorker("worker-late-error", "error me");
	await waitForMicrotasks();
	errorTransport.stdout.write("{not valid RPC JSON}\n");
	await waitForMicrotasks();
	assert.equal(errorManager.getWorker("worker-late-error")?.state.status, "error");
	assert.match(errorManager.getWorker("worker-late-error")?.state.error ?? "", /Failed to parse RPC line/);
	assert.ok(errorEvents.includes("worker_error"));
	errorTransport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(errorManager.getWorker("worker-late-error")?.state.status, "error");
	assert.equal(errorEvents.filter((type) => type === "worker_idle").length, 0);

	const exitTransport = new MockWorkerTransport({ autoCompletePrompt: false });
	const exitManager = await launchRuntimeTestWorker("worker-late-exit", exitTransport);
	const exitEvents: string[] = [];
	exitManager.onEvent((_worker, event) => exitEvents.push(event.type));
	await exitManager.promptWorker("worker-late-exit", "exit me");
	exitTransport.emit("exit", 0, null);
	await waitForMicrotasks();
	exitTransport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(exitManager.getWorker("worker-late-exit")?.state.status, "exited");
	assert.equal(exitEvents.filter((type) => type === "worker_idle").length, 0);

	const rejectTransport = new MockWorkerTransport({ rejectPrompt: "rejected" });
	const rejectManager = await launchRuntimeTestWorker("worker-late-reject", rejectTransport);
	const rejectEvents: string[] = [];
	rejectManager.onEvent((_worker, event) => rejectEvents.push(event.type));
	await assert.rejects(rejectManager.promptWorker("worker-late-reject", "reject me"), /rejected/);
	rejectTransport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(rejectManager.getWorker("worker-late-reject")?.state.status, "error");
	assert.equal(rejectEvents.filter((type) => type === "worker_idle").length, 0);
});

test("extension errors remain diagnostic until agent settlement transitions the worker to idle", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = await launchRuntimeTestWorker("worker-extension-diagnostic", transport);
	await manager.promptWorker("worker-extension-diagnostic", "report extension diagnostics");
	await waitForMicrotasks();

	const lifecycle: Array<{ type: string; status: WorkerStatus; error?: string }> = [];
	manager.onEvent((worker, event) => {
		lifecycle.push({ type: event.type, status: worker.state.status, error: worker.state.error });
	});

	transport.writeEvent({ type: "extension_error", error: "provider extension warning" });
	await waitForMicrotasks();

	const diagnostic = manager.getWorker("worker-extension-diagnostic")?.state;
	assert.equal(diagnostic?.status, "running");
	assert.equal(diagnostic?.error, "provider extension warning");
	assert.deepEqual(lifecycle, [
		{ type: "worker_extension_error", status: "running", error: "provider extension warning" },
	]);

	transport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();

	assert.equal(manager.getWorker("worker-extension-diagnostic")?.state.status, "idle");
	assert.deepEqual(lifecycle.map((entry) => entry.type), ["worker_extension_error", "worker_idle"]);
	assert.equal(lifecycle.filter((entry) => entry.type === "worker_idle").length, 1);
});
test("direct or extension agent_start arms settlement before a non-streaming state refresh", async () => {
	for (const priorStatus of ["starting", "idle"] as const) {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		const workerId = `worker-direct-start-${priorStatus}`;
		const manager = await launchRuntimeTestWorker(workerId, transport);
		const events: string[] = [];
		manager.onEvent((_worker, event) => events.push(event.type));

		if (priorStatus === "idle") {
			await manager.promptWorker(workerId, "establish a settled reusable session");
			transport.writeEvent({ type: "agent_settled" });
			await waitForMicrotasks();
			assert.equal(manager.getWorker(workerId)?.state.status, "idle");
		}

		transport.setState({ isStreaming: false, isCompacting: false });
		transport.writeEvent({ type: "agent_start" });
		await waitForMicrotasks();
		assert.equal(manager.getWorker(workerId)?.state.status, "running");
		await manager.refreshState(workerId);
		assert.equal(manager.getWorker(workerId)?.state.status, "running");
		assert.equal(events.filter((type) => type === "worker_idle").length, priorStatus === "idle" ? 1 : 0);

		transport.writeEvent({ type: "agent_settled" });
		await waitForMicrotasks();
		assert.equal(manager.getWorker(workerId)?.state.status, "idle");
		assert.equal(events.filter((type) => type === "worker_idle").length, priorStatus === "idle" ? 2 : 1);
		await manager.dispose();
	}
});

test("launchWorker rejects controlled spawn failures and removes the broken worker", async () => {
	const manager = new WorkerManager(() => new FailingLaunchHandle());

	await assert.rejects(
		manager.launchWorker({
			workerId: "worker-spawn-fail",
			profileName: "fixer",
			task: taskInput("task-spawn-fail", "Spawn fail", "fixer"),
			cwd: process.cwd(),
			command: "missing-pi-command",
		}),
		/Worker launch failed for worker-spawn-fail: spawn ENOENT/,
	);
	assert.equal(manager.hasWorker("worker-spawn-fail"), false);
});

test("refreshStats does not advance worker activity recency", async () => {
	const originalDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const transport = new MockWorkerTransport();
		const manager = new WorkerManager(() => new MockWorkerHandle(transport));

		await manager.launchWorker({
			workerId: "worker-recency",
			profileName: "reviewer",
			task: taskInput("task-recency", "Recency check"),
			cwd: process.cwd(),
			tools: ["read"],
			extensionMode: "worker-minimal",
		});
		await manager.promptWorker("worker-recency", "finish quietly");
		await waitForMicrotasks();
		await waitForMicrotasks();
		transport.writeEvent({ type: "agent_settled" });
		await waitForMicrotasks();

		const before = manager.getWorker("worker-recency")?.state;
		assert.equal(before?.status, "idle");
		assert.equal(before?.lastEventAt, 1_000);

		now += 10 * 60 * 1_000;
		await manager.refreshStats("worker-recency");
		const after = manager.getWorker("worker-recency")?.state;
		assert.equal(after?.usage.inputTokens, 10);
		assert.equal(after?.lastEventAt, before?.lastEventAt);
	} finally {
		Date.now = originalDateNow;
	}
});

test("refreshState preserves stale unreachable terminal statuses without advancing recency", async () => {
	const originalDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const transports = new Map<string, MockWorkerTransport>();
		const manager = new WorkerManager(() => {
			const transport = new MockWorkerTransport({ initialState: { isStreaming: true } });
			transports.set(`worker-terminal-${transports.size + 1}`, transport);
			return new MockWorkerHandle(transport);
		});
		const terminalStatuses: WorkerStatus[] = ["error", "aborted", "exited"];

		for (const [index, status] of terminalStatuses.entries()) {
			const workerId = `worker-terminal-${index + 1}`;
			await manager.launchWorker({
				workerId,
				profileName: "reviewer",
				task: taskInput(`task-terminal-${index + 1}`, `Terminal ${status}`),
				cwd: process.cwd(),
				tools: ["read"],
				extensionMode: "worker-minimal",
			});
			setRuntimeStatus(manager, workerId, status, now);
		}

		now += 10 * 60 * 1_000;
		for (const [index, status] of terminalStatuses.entries()) {
			const workerId = `worker-terminal-${index + 1}`;
			await manager.refreshState(workerId);
			const after = manager.getWorker(workerId)?.state;
			assert.equal(after?.status, status);
			assert.equal(after?.lastEventAt, 1_000);
		}

		const teamState = createDefaultTeamState();
		for (const worker of manager.listWorkers()) {
			teamState.activeWorkers[worker.workerId] = worker.state;
		}
		const plainLines = buildTeamWidgetLines(teamState, { now }).map(stripAnsi);
		assert.ok(
			!plainLines.some((line) => terminalStatuses.some((status) => line.includes(`Terminal ${status}`))),
			`stale terminal workers should remain hidden; got:\n${plainLines.join("\n")}`,
		);
		assert.ok(plainLines.some((line) => line.includes("3 old hidden")), `expected hidden summary; got:\n${plainLines.join("\n")}`);
	} finally {
		Date.now = originalDateNow;
	}
});

test("refreshState advances recency only on live worker_state status changes", async () => {
	const originalDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const transport = new MockWorkerTransport();
		const manager = new WorkerManager(() => new MockWorkerHandle(transport));

		await manager.launchWorker({
			workerId: "worker-state-recency",
			profileName: "reviewer",
			task: taskInput("task-state-recency", "State recency"),
			cwd: process.cwd(),
			tools: ["read"],
			extensionMode: "worker-minimal",
		});
		await manager.promptWorker("worker-state-recency", "finish quietly");
		await waitForMicrotasks();
		await waitForMicrotasks();
		transport.writeEvent({ type: "agent_settled" });
		await waitForMicrotasks();

		const afterComplete = manager.getWorker("worker-state-recency")?.state;
		assert.equal(afterComplete?.status, "idle");
		assert.equal(afterComplete?.lastEventAt, 1_000);

		now = 2_000;
		transport.setState({ isStreaming: true });
		await manager.refreshState("worker-state-recency");
		const afterRunning = manager.getWorker("worker-state-recency")?.state;
		assert.equal(afterRunning?.status, "running");
		assert.equal(afterRunning?.lastEventAt, 2_000);

		now = 3_000;
		transport.setState({ isStreaming: false });
		await manager.refreshState("worker-state-recency");
		const afterIdle = manager.getWorker("worker-state-recency")?.state;
		assert.equal(afterIdle?.status, "idle");
		assert.equal(afterIdle?.lastEventAt, 3_000);

		now = 4_000;
		await manager.refreshState("worker-state-recency");
		const afterSameStatus = manager.getWorker("worker-state-recency")?.state;
		assert.equal(afterSameStatus?.status, "idle");
		assert.equal(afterSameStatus?.lastEventAt, 3_000);
	} finally {
		Date.now = originalDateNow;
	}
});

test("refreshStats passes through Pi RPC fractional cost without recomputing it from token counters", async () => {
	const rpcCost = 0.01987654321;
	const transport = new MockWorkerTransport({
		sessionStats: {
			sessionId: "pi-0.80.6-tiered-cost",
			totalMessages: 7,
			tokens: { input: 800_001, output: 12_345, cacheRead: 654_321, cacheWrite: 9_876, total: 1_476_543 },
			cost: rpcCost,
			contextUsage: { tokens: 812_346, contextWindow: 1_000_000, percent: 81.2346 },
		},
	});
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-tiered-cost",
		profileName: "reviewer",
		task: taskInput("task-tiered-cost", "Tier-derived RPC cost"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.refreshStats("worker-tiered-cost");

	const usage = manager.getWorker("worker-tiered-cost")?.state.usage;
	assert.equal(usage?.inputTokens, 800_001);
	assert.equal(usage?.cacheReadTokens, 654_321);
	assert.equal(usage?.outputTokens, 12_345);
	assert.equal(usage?.costUsd, rpcCost, "get_session_stats().cost is authoritative even for tier-triggering counters");
});

test("refreshStats clears nullable context percent and remaining after compaction", async () => {
	let compacted = false;
	const transport = new MockWorkerTransport({
		sessionStats: () => ({
			sessionId: "mock-session",
			totalMessages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0.01,
			contextUsage: compacted
				? { tokens: null, contextWindow: 200000, percent: null }
				: { tokens: 150000, contextWindow: 200000, percent: 75 },
		}),
	});
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-context-null",
		profileName: "reviewer",
		task: taskInput("task-context-null", "Context null"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.refreshStats("worker-context-null");
	assert.equal(manager.getWorker("worker-context-null")?.state.usage.contextTokens, 150000);
	assert.equal(manager.getWorker("worker-context-null")?.state.usage.contextPercent, 75);
	assert.equal(manager.getWorker("worker-context-null")?.state.usage.contextRemainingTokens, 50000);

	compacted = true;
	await manager.refreshStats("worker-context-null");
	const usage = manager.getWorker("worker-context-null")?.state.usage;
	assert.equal(usage?.contextTokens, undefined);
	assert.equal(usage?.contextWindow, 200000);
	assert.equal(usage?.contextPercent, undefined);
	assert.equal(usage?.contextRemainingTokens, undefined);
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
	transport.writeEvent({ type: "agent_settled" });
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
	transport.writeEvent({ type: "agent_settled" });
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
	transports[0]?.writeEvent({ type: "agent_settled" });
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
	transports[0]?.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	off();

	const afterReuse = manager.getWorker("worker-reuse-1");
	assert.equal(afterReuse?.state.status, "idle");
	assert.doesNotMatch(manager.getWorkerTranscript("worker-reuse-1") ?? "", /transcript truncated/);
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
	transport.writeEvent({ type: "agent_settled" });
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

test("assistant transcript storage caps retained text and exposes truncation in transcript reads", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-transcript-cap",
		profileName: "reviewer",
		task: taskInput("task-transcript-cap", "Transcript cap"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-transcript-cap", "go");
	await waitForMicrotasks();
	const huge = `${"older\n".repeat(30_000)}tail-marker`;
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: huge } });
	await waitForMicrotasks();

	const transcript = manager.getWorkerTranscript("worker-transcript-cap") ?? "";
	assert.match(transcript, /^\[transcript truncated: showing retained tail; omitted /);
	assert.match(transcript, /tail-marker$/);
	assert.doesNotMatch(transcript, /^older\nolder/);
	assert.ok(Buffer.byteLength(transcript, "utf8") < Buffer.byteLength(huge, "utf8"), "copied transcript should be smaller than full stream");
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

test("activity stream pairs tool start and end into bounded command entries while preserving raw console", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-activity-tool",
		profileName: "reviewer",
		task: taskInput("task-activity-tool", "Activity tool"),
		cwd: process.cwd(),
		tools: ["bash"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-activity-tool", "run command");
	await waitForMicrotasks();

	transport.writeEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } });
	transport.writeEvent({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight" }] },
		isError: false,
	});
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-activity-tool") ?? [];
	const command = activity.find((event) => event.toolCallId === "call-1");
	assert.ok(command);
	assert.equal(command.actionKind, "command");
	assert.equal(command.status, "completed");
	assert.equal(command.label, "Ran npm test");
	assert.equal(command.command, "npm test");
	assert.match(command.outputSnippet ?? "", /one\ntwo/);
	assert.doesNotMatch(command.outputSnippet ?? "", /seven/);
	assert.equal(command.hiddenLineCount, 2);
	assert.equal(command.sourceEvent, "worker_tool_finished");

	const consoleEvents = manager.getWorkerConsole("worker-activity-tool") ?? [];
	assert.ok(consoleEvents.some((event) => event.kind === "tool_start" && event.text.includes("npm test")));
	assert.ok(consoleEvents.some((event) => event.kind === "tool_end" && event.text.includes("one")));
});

test("activity stream extracts process and final-answer summaries without adding persisted fields", async () => {
	const finalAnswerBody = [
		"headline: implemented activity lane",
		"risks:",
		"- overlay wiring remains separate",
		"next_recommendation: hand off to UI lane",
	].join("\n");
	const transport = new MockWorkerTransport({
		promptText: `mapping runtime state\n<final_answer>\n${finalAnswerBody}\n</final_answer>`,
	});
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));
	const observed: string[] = [];
	const off = manager.onActivityEvent((workerId, event) => observed.push(`${workerId}:${event.actionKind}:${event.label}`));

	await manager.launchWorker({
		workerId: "worker-activity-final",
		profileName: "reviewer",
		task: taskInput("task-activity-final", "Activity final"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-activity-final", "summarize");
	await waitForMicrotasks();
	await waitForMicrotasks();
	manager.getWorkerActivity("worker-activity-final");
	const worker = manager.getWorker("worker-activity-final");
	const activity = manager.getWorkerActivity("worker-activity-final") ?? [];
	const processEntry = activity.find((event) => event.actionKind === "process");
	const finalEntry = activity.find((event) => event.actionKind === "final_summary");
	assert.ok(processEntry);
	assert.match(processEntry.summary ?? "", /Working on:/);
	assert.ok(finalEntry);
	assert.equal(finalEntry.label, "Final answer");
	assert.equal(finalEntry.finalSummaryFields?.headline, "implemented activity lane");
	assert.deepEqual(finalEntry.finalSummaryFields?.risks, ["overlay wiring remains separate"]);
	assert.equal(finalEntry.finalSummaryFields?.nextRecommendation, "hand off to UI lane");
	assert.match(finalEntry.summary ?? "", /implemented activity lane/);
	assert.equal((worker?.state as Record<string, unknown>).activity, undefined);
	assert.ok(observed.some((event) => event.includes("worker-activity-final:final_summary:Final answer")));
	off();
});

test("activity stream classifies streamed final-answer deltas instead of exposing raw tags as Thinking", async () => {
	const finalAnswerBody = [
		"headline: streamed final summary",
		"risks:",
		"- none",
		"next_recommendation: reviewer spot-check",
	].join("\n");
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-stream-final",
		profileName: "reviewer",
		task: taskInput("task-stream-final", "Stream final"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-stream-final", "stream a final answer");
	await waitForMicrotasks();

	transport.writeEvent({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			delta: `\n<final_answer>\n${finalAnswerBody}\n</final_answer>\n${".".repeat(260)}`,
		},
	});
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-stream-final") ?? [];
	const finalEntry = activity.find((event) => event.actionKind === "final_summary");
	assert.ok(finalEntry);
	assert.equal(finalEntry.finalSummaryFields?.headline, "streamed final summary");
	const rawTaggedThinking = activity.find((event) => event.actionKind === "process" && /<\/?final[_\s-]?answer>/i.test(event.summary ?? ""));
	assert.equal(rawTaggedThinking, undefined);
});

test("activity stream preserves split streamed final-answer blocks across read-side flushes", async () => {
	const finalAnswerBody = [
		"headline: split stream summary",
		"risks:",
		"- flush boundary handled",
		"next_recommendation: merge after review",
	].join("\n");
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-split-final",
		profileName: "reviewer",
		task: taskInput("task-split-final", "Split final"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-split-final", "stream split final answer");
	await waitForMicrotasks();

	manager.getWorkerActivity("worker-split-final");
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n<final_answer>\nheadline: split" } });
	await waitForMicrotasks();
	manager.getWorkerActivity("worker-split-final");
	transport.writeEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: ` stream summary\n${finalAnswerBody.split("\n").slice(1).join("\n")}\n</final_answer>` },
	});
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-split-final") ?? [];
	const finalEntries = activity.filter((event) => event.actionKind === "final_summary");
	assert.equal(finalEntries.length, 1);
	assert.equal(finalEntries[0].finalSummaryFields?.headline, "split stream summary");
	assert.equal(finalEntries[0].finalSummaryFields?.nextRecommendation, "merge after review");
	assert.equal(manager.getWorker("worker-split-final")?.state.finalAnswer, finalAnswerBody);
	const rawTaggedThinking = activity.find((event) => event.actionKind === "process" && /<\/?final[_\s-]?answer>/i.test(event.summary ?? ""));
	assert.equal(rawTaggedThinking, undefined);
});

test("activity stream dedupes streamed and canonical final-answer summaries", async () => {
	const finalAnswer = [
		"headline: one canonical summary",
		"risks:",
		"- duplicate suppressed",
		"next_recommendation: ship once",
	].join("\n");
	const finalAnswerText = `<final_answer>\n${finalAnswer}\n</final_answer>`;
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-dedupe-final",
		profileName: "reviewer",
		task: taskInput("task-dedupe-final", "Dedupe final"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-dedupe-final", "stream then end");
	await waitForMicrotasks();

	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: finalAnswerText } });
	await waitForMicrotasks();
	manager.getWorkerActivity("worker-dedupe-final");
	transport.completePrompt(`preamble\n${finalAnswerText}\ntrailing`);
	await waitForMicrotasks();

	const finalEntries = (manager.getWorkerActivity("worker-dedupe-final") ?? []).filter((event) => event.actionKind === "final_summary");
	assert.equal(finalEntries.length, 1);
	assert.equal(finalEntries[0].finalSummaryFields?.headline, "one canonical summary");
});

test("activity getters do not flush token-sized streamed thinking into durable process rows", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-read-stable",
		profileName: "reviewer",
		task: taskInput("task-read-stable", "Read stability"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-read-stable", "stream tiny deltas");
	await waitForMicrotasks();
	for (const delta of ["a", "b", "c", "d", "e"]) {
		transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
		manager.getWorkerActivity("worker-read-stable");
		manager.getWorkerConsole("worker-read-stable");
	}
	await waitForMicrotasks();

	const activityBeforeBoundary = manager.getWorkerActivity("worker-read-stable") ?? [];
	assert.equal(activityBeforeBoundary.filter((event) => event.actionKind === "process" && event.label === "Thinking").length, 0);
	transport.writeEvent({ type: "tool_execution_start", toolCallId: "boundary", toolName: "read", args: { path: "x.ts" } });
	await waitForMicrotasks();
	const activityAfterBoundary = manager.getWorkerActivity("worker-read-stable") ?? [];
	const thinking = activityAfterBoundary.filter((event) => event.actionKind === "process" && event.label === "Thinking");
	assert.equal(thinking.length, 1);
	assert.match(thinking[0].summary ?? "", /abcde$/);
});

test("activity reads can discover final answers without emitting token-sized thinking", async () => {
	const finalAnswer = [
		"headline: read-side final freshness",
		"risks:",
		"- none",
		"next_recommendation: copy inspect can read it",
	].join("\n");
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-read-final",
		profileName: "reviewer",
		task: taskInput("task-read-final", "Read final"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-read-final", "stream final");
	await waitForMicrotasks();
	transport.writeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `<final_answer>\n${finalAnswer}\n</final_answer>` } });
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-read-final") ?? [];
	const finalEntry = activity.find((event) => event.actionKind === "final_summary");
	assert.ok(finalEntry);
	assert.equal(finalEntry.finalSummaryFields?.headline, "read-side final freshness");
	assert.equal(manager.getWorker("worker-read-final")?.state.finalAnswer, finalAnswer);
	assert.equal(activity.find((event) => event.actionKind === "process" && event.label === "Thinking"), undefined);
});

test("activity cap prunes pending tool mappings and preserves standalone finishes", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-pruned-finish",
		profileName: "reviewer",
		task: taskInput("task-pruned-finish", "Pruned finish"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-pruned-finish", "many tools");
	await waitForMicrotasks();
	for (let i = 0; i < 620; i += 1) {
		transport.writeEvent({ type: "tool_execution_start", toolCallId: `pruned-${i}`, toolName: "read", args: { path: `file-${i}.ts` } });
	}
	transport.writeEvent({
		type: "tool_execution_end",
		toolCallId: "pruned-0",
		toolName: "read",
		result: { content: [{ type: "text", text: "old start finished after pruning" }] },
		isError: false,
	});
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-pruned-finish") ?? [];
	assert.ok(activity.length <= 500);
	const finish = activity.find((event) => event.toolCallId === "pruned-0");
	assert.ok(finish);
	assert.equal(finish.status, "completed");
	assert.equal(finish.outputSnippet, "old start finished after pruning");
	assert.equal(finish.label, "read finished");
});

test("activity stream remains bounded independently from console events", async () => {
	const transport = new MockWorkerTransport({ autoCompletePrompt: false });
	const manager = new WorkerManager(() => new MockWorkerHandle(transport));

	await manager.launchWorker({
		workerId: "worker-activity-cap",
		profileName: "reviewer",
		task: taskInput("task-activity-cap", "Activity cap"),
		cwd: process.cwd(),
		tools: ["read"],
		extensionMode: "worker-minimal",
	});
	await manager.promptWorker("worker-activity-cap", "many events");
	await waitForMicrotasks();
	for (let i = 0; i < 620; i += 1) {
		transport.writeEvent({ type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "read", args: { path: `file-${i}.ts` } });
	}
	await waitForMicrotasks();

	const activity = manager.getWorkerActivity("worker-activity-cap") ?? [];
	const consoleEvents = manager.getWorkerConsole("worker-activity-cap") ?? [];
	assert.ok(activity.length <= 500, `activity buffer should be capped, got ${activity.length}`);
	assert.ok(consoleEvents.length <= 500, `console buffer should be capped, got ${consoleEvents.length}`);
	assert.ok(activity.at(-1)?.summary?.includes("file-619.ts"));
	assert.ok(consoleEvents.at(-1)?.text.includes("file-619.ts"));
});

test("activity stream keeps IDs unique after cap pruning so tool finishes patch the intended row", async () => {
	const originalDateNow = Date.now;
	Date.now = () => 123_456;
	try {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		const manager = new WorkerManager(() => new MockWorkerHandle(transport));

		await manager.launchWorker({
			workerId: "worker-activity-id-cap",
			profileName: "reviewer",
			task: taskInput("task-activity-id-cap", "Activity id cap"),
			cwd: process.cwd(),
			tools: ["read"],
			extensionMode: "worker-minimal",
		});
		await manager.promptWorker("worker-activity-id-cap", "many same-ms events");
		await waitForMicrotasks();
		for (let i = 0; i < 620; i += 1) {
			transport.writeEvent({ type: "tool_execution_start", toolCallId: `same-ms-${i}`, toolName: "read", args: { path: `file-${i}.ts` } });
		}
		transport.writeEvent({
			type: "tool_execution_end",
			toolCallId: "same-ms-619",
			toolName: "read",
			result: { content: [{ type: "text", text: "latest finished" }] },
			isError: false,
		});
		await waitForMicrotasks();

		const activity = manager.getWorkerActivity("worker-activity-id-cap") ?? [];
		const ids = activity.map((event) => event.id);
		assert.equal(new Set(ids).size, ids.length, "retained activity IDs must remain unique after cap pruning");
		const latest = activity.find((event) => event.toolCallId === "same-ms-619");
		assert.ok(latest);
		assert.equal(latest.status, "completed");
		assert.equal(latest.outputSnippet, "latest finished");
		const incorrectlyPatched = activity.find((event) => event.toolCallId !== "same-ms-619" && event.outputSnippet === "latest finished");
		assert.equal(incorrectlyPatched, undefined);
	} finally {
		Date.now = originalDateNow;
	}
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
