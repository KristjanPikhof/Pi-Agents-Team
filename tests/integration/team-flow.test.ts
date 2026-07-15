import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

test("team flow delegates, steers, pings, follows up, and exposes relay state end to end", async () => {
	let transport: MockWorkerTransport | undefined;
	const workerManager = new WorkerManager(() => {
		transport = new MockWorkerTransport({
			autoCompletePrompt: false,
			promptText:
				"headline: worker completed\nrelay_question: Should I stop here?\nassumption: I will stop until the orchestrator replies.",
		});
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const result = await teamManager.delegateTask({
		title: "Integration smoke",
		goal: "Exercise the full team orchestration flow",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	await teamManager.messageWorker(result.worker.workerId, "Narrow the scope while you are running", "steer");
	const relayWait = teamManager.waitForTerminal([result.worker.workerId], { timeoutMs: 500 });
	transport?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	const relayWake = await relayWait;
	assert.equal(relayWake.reason, "relay_raised", "relay wake remains available before settlement");
	const beforeSettlement = await teamManager.pingWorkers({ mode: "active" });
	assert.equal(beforeSettlement.length, 1);
	assert.equal(beforeSettlement[0]?.worker.status, "running");
	assert.equal(beforeSettlement[0]?.worker.pendingRelayQuestions.length, 1);
	assert.equal(
		(await teamManager.waitForTerminal([result.worker.workerId], { timeoutMs: 20 })).reason,
		"timeout",
		"agent_end must not complete the team wait",
	);
	await assert.rejects(
		teamManager.delegateTask({
			title: "Premature reuse",
			goal: "must remain unavailable",
			profileName: "reviewer",
			cwd: process.cwd(),
			reuseWorkerId: result.worker.workerId,
		}),
		/Cannot reuse worker.*running/,
	);

	transport?.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	await waitForMicrotasks();
	assert.equal((await teamManager.waitForTerminal([result.worker.workerId], { timeoutMs: 20 })).reason, "all_terminal");

	await teamManager.messageWorker(result.worker.workerId, "Thanks, next step please", "follow_up");
	const listed = teamManager.listWorkers();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.profileName, "reviewer");
	const promptCommands = transport?.commands.filter((c) => c.type === "prompt") ?? [];
	assert.equal(promptCommands.length, 2);
	assert.equal(promptCommands.at(-1)?.message, "Thanks, next step please");
});
