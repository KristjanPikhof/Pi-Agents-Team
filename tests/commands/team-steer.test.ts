import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { _testing as steerTesting, registerTeamSteerCommand } from "../../src/commands/team-steer";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installTeamSteerCommand(teamManager: TeamManager) {
	const commands: RegisteredCommand[] = [];
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	registerTeamSteerCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{
			teamManager,
			emitText: (_ctx, text) => emitted.push(text),
		},
	);
	const cmd = commands.find((c) => c.name === "team-steer");
	assert.ok(cmd, "team-steer command must register");
	const ctx = {
		cwd: process.cwd(),
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
	} as any;
	return {
		run: (args: string) => cmd!.handler(args, ctx),
		emitted,
		notifications,
	};
}

test("parseSteerArgs accepts <target> <message>, [--queue], and rejects missing parts", () => {
	assert.deepEqual(steerTesting.parseSteerArgs("w1 hello there"), { target: "w1", message: "hello there", queue: false });
	assert.deepEqual(steerTesting.parseSteerArgs("all  also  check  tests"), { target: "all", message: "also  check  tests", queue: false });
	assert.deepEqual(steerTesting.parseSteerArgs("--queue w1 narrow scope"), { target: "w1", message: "narrow scope", queue: true });
	assert.deepEqual(steerTesting.parseSteerArgs("w2 --queue narrow scope"), { target: "w2", message: "narrow scope", queue: true });

	const empty = steerTesting.parseSteerArgs("");
	assert.match(empty.error ?? "", /Usage:/);

	const noMsg = steerTesting.parseSteerArgs("w1");
	assert.match(noMsg.error ?? "", /Usage:/);

	const onlyFlag = steerTesting.parseSteerArgs("--queue");
	assert.match(onlyFlag.error ?? "", /Usage:/);
});

test("/team-steer running worker → 'steer' delivery", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Inspect",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "running");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run(`${delegated.worker.workerId} narrow the scope`);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, new RegExp(`Steered ${delegated.worker.workerId}`));
});

test("/team-steer idle worker → upgrades to 'prompt' so the session wakes (CLAUDE.md 3-way union)", async () => {
	const transport = new MockWorkerTransport();
	const workerManager = new WorkerManager(() => new MockWorkerHandle(transport));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "complete fast",
		goal: "complete and idle",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	transport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "idle");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run(`${delegated.worker.workerId} also check tests`);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, new RegExp(`Prompted ${delegated.worker.workerId}`));
});

test("/team-steer --queue on a running worker forces 'follow_up' delivery", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Inspect",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "running");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run(`--queue ${delegated.worker.workerId} queued nudge`);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, new RegExp(`Queued follow-up for ${delegated.worker.workerId}`));
});

test("/team-steer --queue on an idle worker still upgrades to 'prompt' (resolver wakes the session)", async () => {
	const transport = new MockWorkerTransport();
	const workerManager = new WorkerManager(() => new MockWorkerHandle(transport));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "complete fast",
		goal: "complete and idle",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	transport.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "idle");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run(`--queue ${delegated.worker.workerId} late nudge`);
	assert.equal(harness.emitted.length, 1);
	// CLAUDE.md "Delivery resolution is a 3-way union": idle/waiting must NOT
	// pre-block; messageWorker resolver upgrades to prompt regardless of input.
	assert.match(harness.emitted[0]!, new RegExp(`Prompted ${delegated.worker.workerId}`));
});

test("/team-steer terminal worker is refused via notify (CLAUDE.md: terminal workers reject messages)", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Doomed",
		goal: "exit",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await teamManager.cancelWorker(delegated.worker.workerId);
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "exited");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run(`${delegated.worker.workerId} are you there`);
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /exited|disposed|Re-delegate/);
});

test("/team-steer all routes by per-worker status and tolerates partial failure", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const running = await teamManager.delegateTask({
		title: "still running",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const idle = await teamManager.delegateTask({
		title: "complete then idle",
		goal: "complete",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	transports[1]?.completePrompt();
	transports[1]?.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	await waitForMicrotasks();

	assert.equal(teamManager.getWorkerStatus(running.worker.workerId)?.status, "running");
	assert.equal(teamManager.getWorkerStatus(idle.worker.workerId)?.status, "idle");

	const harness = installTeamSteerCommand(teamManager);
	await harness.run("all check the spec link");
	assert.equal(harness.emitted.length, 1);
	const out = harness.emitted[0]!;
	// Running gets 'Steered', idle upgrades to 'Prompted'.
	assert.match(out, new RegExp(`Steered ${running.worker.workerId}`));
	assert.match(out, new RegExp(`Prompted ${idle.worker.workerId}`));
});

test("/team-steer all swallows per-worker errors (CLAUDE.md: broadcasts must not abort on single failure)", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const w1 = await teamManager.delegateTask({
		title: "first",
		goal: "first",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	const w2 = await teamManager.delegateTask({
		title: "second",
		goal: "second",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const harness = installTeamSteerCommand(teamManager);
	await harness.run("all check the spec link");
	assert.equal(harness.emitted.length, 1);
	// Both workers should appear in the output regardless of any per-worker
	// quirks; emitted output never aborts mid-broadcast.
	const out = harness.emitted[0]!;
	assert.ok(out.includes(w1.worker.workerId), `expected ${w1.worker.workerId} in output, got: ${out}`);
	assert.ok(out.includes(w2.worker.workerId), `expected ${w2.worker.workerId} in output, got: ${out}`);
});

test("/team-steer with missing message notifies usage", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const harness = installTeamSteerCommand(teamManager);
	await harness.run("");
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /Usage: \/team-steer/);
});
