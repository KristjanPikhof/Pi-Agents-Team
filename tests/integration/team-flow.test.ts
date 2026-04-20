import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

test("team flow delegates, steers, pings, follows up, and exposes relay state end to end", async () => {
	const workerManager = new WorkerManager(() =>
		new MockWorkerHandle(
			new MockWorkerTransport({
				autoCompletePrompt: false,
				promptText:
					"headline: worker completed\nrelay_question: Should I stop here?\nassumption: I will stop until the orchestrator replies.",
			}),
		),
	);
	const teamManager = new TeamManager({ workerManager });

	const result = await teamManager.delegateTask({
		title: "Integration smoke",
		goal: "Exercise the full team orchestration flow",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	await teamManager.messageWorker(result.worker.workerId, "Narrow the scope while you are running", "steer");
	const transport = (workerManager as any).workers?.get?.(result.worker.workerId)?.handle.transport as MockWorkerTransport | undefined;
	transport?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	const ping = await teamManager.pingWorkers({ mode: "active" });
	assert.equal(ping.length, 1);
	assert.equal(ping[0]?.worker.pendingRelayQuestions.length, 1);

	await teamManager.messageWorker(result.worker.workerId, "Thanks, stay idle", "follow_up");
	const listed = teamManager.listWorkers();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.profileName, "reviewer");
});
