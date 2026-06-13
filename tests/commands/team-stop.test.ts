import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { registerTeamStopCommand } from "../../src/commands/team-stop";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installTeamStopCommand(teamManager: TeamManager) {
	const commands: RegisteredCommand[] = [];
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	registerTeamStopCommand(
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
	const cmd = commands.find((c) => c.name === "team-stop");
	assert.ok(cmd, "team-stop command must register");
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

test("/team-stop without args notifies usage", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const harness = installTeamStopCommand(teamManager);
	await harness.run("");
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /Usage: \/team-stop/);
});

test("/team-stop <id> on a running worker takes the cancel path → exited", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Long runner",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "running");

	const harness = installTeamStopCommand(teamManager);
	await harness.run(delegated.worker.workerId);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, new RegExp(`Worker ${delegated.worker.workerId} \\(reviewer\\): cancel → (exited|aborted)`));
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "exited");
});

test("/team-stop <id> on an idle worker takes the close path → exited", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Quick win",
		goal: "complete and idle",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await waitForMicrotasks();
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "idle");

	const harness = installTeamStopCommand(teamManager);
	await harness.run(delegated.worker.workerId);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, new RegExp(`Worker ${delegated.worker.workerId} \\(reviewer\\): close → exited`));
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "exited");
});

test("/team-stop <id> on a terminal worker refuses without crashing", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const delegated = await teamManager.delegateTask({
		title: "Doomed",
		goal: "be terminal",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await teamManager.cancelWorker(delegated.worker.workerId);
	assert.equal(teamManager.getWorkerStatus(delegated.worker.workerId)?.status, "exited");

	const harness = installTeamStopCommand(teamManager);
	await harness.run(delegated.worker.workerId);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, /already exited; nothing to stop\./);
});

test("/team-stop <unknown> notifies and does not emit", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const harness = installTeamStopCommand(teamManager);
	await harness.run("does-not-exist");
	assert.equal(harness.emitted.length, 0);
	assert.match(harness.notifications[0]?.message ?? "", /Unknown worker/);
});

test("/team-stop all stops a mix of running, idle, and terminal workers without aborting on per-worker errors", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ autoCompletePrompt: false });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	// Worker 1: running (autoCompletePrompt false)
	const running = await teamManager.delegateTask({
		title: "still running",
		goal: "stay running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	// Worker 2: complete to drive it to idle
	const idle = await teamManager.delegateTask({
		title: "complete then idle",
		goal: "complete",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	transports[1]?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();

	// Worker 3: pre-cancel to terminal
	const terminal = await teamManager.delegateTask({
		title: "doomed",
		goal: "exit",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await teamManager.cancelWorker(terminal.worker.workerId);

	assert.equal(teamManager.getWorkerStatus(running.worker.workerId)?.status, "running");
	assert.equal(teamManager.getWorkerStatus(idle.worker.workerId)?.status, "idle");
	assert.equal(teamManager.getWorkerStatus(terminal.worker.workerId)?.status, "exited");

	const harness = installTeamStopCommand(teamManager);
	await harness.run("all");
	assert.equal(harness.emitted.length, 1);
	const out = harness.emitted[0]!;
	// Terminal worker must be filtered out by the all-broadcast (CLAUDE.md:
	// "Broadcasts swallow per-worker errors" — and we further filter terminal
	// upfront so we don't even attempt them).
	assert.ok(out.includes("Stopped 2 worker"), `expected 2 in summary, got: ${out}`);
	assert.match(out, new RegExp(`Worker ${running.worker.workerId} \\(reviewer\\): cancel → exited`));
	assert.match(out, new RegExp(`Worker ${idle.worker.workerId} \\(reviewer\\): close → exited`));
	assert.equal(teamManager.getWorkerStatus(running.worker.workerId)?.status, "exited");
	assert.equal(teamManager.getWorkerStatus(idle.worker.workerId)?.status, "exited");
});

test("/team-stop all reports per-worker errors instead of aborting the broadcast", async () => {
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

	// Force first cancelWorker to throw; second must still succeed.
	let calls = 0;
	const original = teamManager.cancelWorker.bind(teamManager);
	(teamManager as any).cancelWorker = async (workerId: string) => {
		calls += 1;
		if (workerId === w1.worker.workerId) {
			throw new Error("simulated runtime failure");
		}
		return original(workerId);
	};

	const harness = installTeamStopCommand(teamManager);
	await harness.run("all");
	assert.ok(calls >= 2, "broadcast must continue past the failing worker");
	assert.equal(harness.emitted.length, 1);
	const out = harness.emitted[0]!;
	assert.match(out, new RegExp(`Worker ${w1.worker.workerId}: error — simulated runtime failure`));
	assert.match(out, new RegExp(`Worker ${w2.worker.workerId} \\(reviewer\\): cancel → exited`));
});
