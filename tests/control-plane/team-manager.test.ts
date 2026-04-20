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
