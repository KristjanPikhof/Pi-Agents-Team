import test from "node:test";
import assert from "node:assert/strict";
import { registerTeamCommand } from "../../src/commands/team";
import { createDefaultTeamState } from "../../src/config";
import type { PersistedTeamState, WorkerRuntimeState } from "../../src/types";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function makeWorker(workerId: string): WorkerRuntimeState {
	const now = Date.now();
	return {
		workerId,
		profileName: "reviewer",
		sessionMode: "worker",
		status: "running",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		usage: {
			turns: 1,
			inputTokens: 100,
			outputTokens: 25,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
		currentTask: {
			taskId: "task-1",
			title: "Review RPC dashboard fallback",
			goal: "Keep /team useful outside the TUI",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: now,
		},
	};
}

function makeState(): PersistedTeamState {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker("w1");
	return state;
}

function installTeamCommand(state = makeState(), displayCost = true) {
	const commands: RegisteredCommand[] = [];
	const emitted: string[] = [];
	const calls = { pings: [] as Array<{ mode?: string }>, custom: 0, notifications: [] as string[] };
	const manager = {
		listWorkers: () => Object.values(state.activeWorkers),
		resolveWorkerId: (input: string) => state.activeWorkers[input] ? input : undefined,
		snapshot: () => state,
		displayCost,
		pingWorkers: async (options?: { mode?: "passive" | "active" }) => {
			calls.pings.push(options ?? {});
			return [];
		},
	};
	registerTeamCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{
			teamManager: manager as any,
			emitText: (_ctx, text) => emitted.push(text),
		},
	);
	const command = commands.find((item) => item.name === "team");
	assert.ok(command, "team command must register");
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			custom: async () => { calls.custom += 1; throw new Error("custom must not be called in RPC mode"); },
			notify: (message: string) => calls.notifications.push(message),
		},
	};
	return { run: (args = "") => command!.handler(args, ctx), emitted, calls };
}

test("/team in RPC mode with hasUI=true emits refreshed text instead of opening a custom overlay", async () => {
	const harness = installTeamCommand();
	await harness.run("");

	assert.equal(harness.calls.custom, 0);
	assert.deepEqual(harness.calls.pings, [{ mode: "active" }]);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, /Pi Agents Team Dashboard/);
	assert.match(harness.emitted[0]!, /reviewer \(w1\)/);
	assert.match(harness.emitted[0]!, /status: running/);
});

test("/team in RPC mode mirrors display.cost false in fallback text", async () => {
	const harness = installTeamCommand(makeState(), false);
	await harness.run("");

	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, /Workers \/ Inspect \/ Console tabs/);
	assert.doesNotMatch(harness.emitted[0]!, /Workers \/ Inspect \/ Console \/ Cost tabs/);
});

test("/team <unknown> in RPC mode emits the warning text without calling ctx.ui.notify", async () => {
	const harness = installTeamCommand();
	await harness.run("missing");

	assert.equal(harness.calls.custom, 0);
	assert.equal(harness.calls.notifications.length, 0);
	assert.equal(harness.calls.pings.length, 0);
	assert.equal(harness.emitted.length, 1);
	assert.match(harness.emitted[0]!, /Unknown worker/);
});
