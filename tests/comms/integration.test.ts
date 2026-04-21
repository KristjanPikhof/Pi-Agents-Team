import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

test("communication flow supports steer while running, follow-up while idle, passive ping, and relay capture", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({
			autoCompletePrompt: false,
			promptText:
				"headline: Worker finished first pass\nrelay_question: Should I widen the search scope?\nassumption: I will keep the current scope unless told otherwise.",
		});
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Inspect relay flow",
		goal: "Verify comms behavior",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	await teamManager.messageWorker(delegated.worker.workerId, "Interrupt and narrow to passive ping only", "auto");
	assert.ok(transports[0]?.commands.some((command) => command.type === "steer"));

	transports[0]?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	const [worker] = teamManager.listWorkers();
	assert.ok(worker);
	assert.equal(worker.pendingRelayQuestions.length, 1);

	const passivePing = await teamManager.pingWorkers({ mode: "passive" });
	assert.equal(passivePing[0]?.worker.workerId, worker.workerId);
	assert.equal(passivePing[0]?.worker.pendingRelayQuestions.length, 1);

	await teamManager.messageWorker(worker.workerId, "Continue with the current scope", "auto");
	const promptCommands = transports[0]?.commands.filter((command) => command.type === "prompt") ?? [];
	assert.equal(promptCommands.length, 2, "idle worker should receive the message as a fresh prompt (wakes the session)");
	assert.equal(promptCommands.at(-1)?.message, "Continue with the current scope");
	assert.ok(!transports[0]?.commands.some((command) => command.type === "follow_up"));
});
