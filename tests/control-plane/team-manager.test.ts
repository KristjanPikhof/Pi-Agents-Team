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
