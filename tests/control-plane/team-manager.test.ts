import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

test("TeamManager delegates, tracks, pings, and cancels workers", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Inspect runtime",
		goal: "Check the runtime layer for regressions",
		profileName: "reviewer",
		cwd: process.cwd(),
		contextHints: ["Focus on JSONL framing"],
	});

	assert.ok(delegated.task);
	assert.equal(teamManager.listWorkers().length, 1);

	await waitForMicrotasks();
	await waitForMicrotasks();

	const [worker] = teamManager.listWorkers();
	assert.ok(worker);
	assert.match(worker.lastSummary?.headline ?? "", /Completed/);

	const activePing = await teamManager.pingWorkers({ mode: "active" });
	assert.equal(activePing.length, 1);
	assert.equal(activePing[0]?.worker.usage.inputTokens, 10);

	const messaged = await teamManager.messageWorker(worker.workerId, "Focus only on abort handling", "steer");
	assert.equal(messaged.worker.workerId, worker.workerId);

	const cancelled = await teamManager.cancelWorker(worker.workerId);
	assert.equal(cancelled.worker.status, "exited");
});

test("waitForTerminal resolves all_terminal once every target finishes", async () => {
	let transport: MockWorkerTransport | undefined;
	const workerManager = new WorkerManager(() => {
		transport = new MockWorkerTransport({ autoCompletePrompt: false });
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const { worker } = await teamManager.delegateTask({
		title: "Wait test",
		goal: "Exercise waitForTerminal",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const pending = teamManager.waitForTerminal([worker.workerId], { timeoutMs: 500 });
	transport?.completePrompt();
	const resolved = await pending;
	assert.equal(resolved.reason, "all_terminal");
	assert.equal(resolved.workers.length, 1);
	assert.equal(resolved.workers[0]?.status, "idle");
});

test("waitForTerminal wakes early when a running worker raises a new relay", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({
			autoCompletePrompt: false,
			promptText: "headline: partial\nrelay_question: Should I narrow scope?\nassumption: keep broad.",
		});
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const running = await teamManager.delegateTask({
		title: "Relay wake",
		goal: "stay running until completePrompt",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const raiser = await teamManager.delegateTask({
		title: "Relay source",
		goal: "emit a relay mid-flight",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const pending = teamManager.waitForTerminal(
		[running.worker.workerId, raiser.worker.workerId],
		{ timeoutMs: 1000 },
	);
	transports[1]?.completePrompt();
	const resolved = await pending;

	assert.equal(resolved.reason, "relay_raised");
	assert.ok(resolved.newRelays && resolved.newRelays.length >= 1);
	assert.equal(resolved.newRelays![0]?.workerId, raiser.worker.workerId);
	assert.match(resolved.newRelays![0]?.question ?? "", /narrow scope/);
});

test("waitForTerminal with wakeOnRelay:false ignores relays and waits for terminal", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({
			autoCompletePrompt: false,
			promptText: "headline: done\nrelay_question: Should I keep going?\nassumption: yes",
		});
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const { worker } = await teamManager.delegateTask({
		title: "Opt-out wake",
		goal: "verify wakeOnRelay:false still waits for terminal",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const pending = teamManager.waitForTerminal([worker.workerId], { timeoutMs: 1000, wakeOnRelay: false });
	transports[0]?.completePrompt();
	const resolved = await pending;
	assert.equal(resolved.reason, "all_terminal");
});

test("waitForTerminal times out while the worker stays running", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const { worker } = await teamManager.delegateTask({
		title: "Timeout test",
		goal: "Verify waitForTerminal honors timeoutMs",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const resolved = await teamManager.waitForTerminal([worker.workerId], { timeoutMs: 20 });
	assert.equal(resolved.reason, "timeout");
	assert.equal(resolved.workers[0]?.status, "running");
});

test("messageWorker returns the resolved delivery mode for each call", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const { worker } = await teamManager.delegateTask({
		title: "Delivery routing",
		goal: "Verify auto delivery routes by current worker status",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const whileRunning = await teamManager.messageWorker(worker.workerId, "narrow the scope", "auto");
	assert.equal(whileRunning.delivery, "steer");

	transports[0]?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	const whileIdle = await teamManager.messageWorker(worker.workerId, "also check tests", "auto");
	assert.equal(whileIdle.delivery, "follow_up");
});

test("messageAllWorkers broadcasts to every deliverable worker", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const first = await teamManager.delegateTask({
		title: "Broadcast w1",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const second = await teamManager.delegateTask({
		title: "Broadcast w2",
		goal: "complete then idle",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	transports[1]?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	const broadcast = await teamManager.messageAllWorkers("remember the spec link", "auto");
	assert.equal(broadcast.length, 2);
	const byId = new Map(broadcast.map((r) => [r.worker.workerId, r]));
	assert.equal(byId.get(first.worker.workerId)?.delivery, "steer");
	assert.equal(byId.get(second.worker.workerId)?.delivery, "follow_up");
});

test("pruneTerminalWorkers removes only terminal workers and leaves live ones alone", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const live = await teamManager.delegateTask({
		title: "Still running",
		goal: "stay alive",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const doomed = await teamManager.delegateTask({
		title: "Will be cancelled",
		goal: "get pruned",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await teamManager.cancelWorker(doomed.worker.workerId);

	assert.equal(teamManager.listWorkers().length, 2);
	const removed = teamManager.pruneTerminalWorkers();
	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.workerId, doomed.worker.workerId);
	const remaining = teamManager.listWorkers();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]?.workerId, live.worker.workerId);
});

test("aggregateUsage sums token and cost fields across every tracked worker", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport();
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	await teamManager.delegateTask({
		title: "Usage aggregation A",
		goal: "produce some tokens",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await teamManager.delegateTask({
		title: "Usage aggregation B",
		goal: "produce some more tokens",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await waitForMicrotasks();

	await teamManager.pingWorkers({ mode: "active" });
	const agg = teamManager.aggregateUsage();
	assert.equal(agg.workers, 2);
	assert.ok(agg.inputTokens >= 20);
	assert.ok(agg.costUsd >= 0.02);
});

test("cancelAllWorkers aborts only non-terminal workers and skips the rest", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const alpha = await teamManager.delegateTask({
		title: "Cancel all — alpha",
		goal: "first live worker",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const beta = await teamManager.delegateTask({
		title: "Cancel all — beta",
		goal: "second live worker",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	await teamManager.cancelWorker(alpha.worker.workerId);

	const results = await teamManager.cancelAllWorkers();
	assert.equal(results.length, 1);
	assert.equal(results[0]?.worker.workerId, beta.worker.workerId);
	assert.equal(results[0]?.worker.status, "exited");

	const allTerminal = teamManager.listWorkers().every((worker) => ["exited", "aborted", "error", "completed", "idle"].includes(worker.status));
	assert.ok(allTerminal);
});
