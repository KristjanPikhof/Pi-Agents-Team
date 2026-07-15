import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import type { WorkerProcessOptions } from "../../src/runtime/worker-process";
import { resolveProfile } from "../../src/profiles/loader";
import { MockWorkerHandle, MockWorkerTransport, waitForMicrotasks } from "../runtime/test-helpers";
import { buildTeamWidgetLines } from "../../src/ui/status-widget";
import type { WorkerRuntimeState } from "../../src/types";

async function settleTransport(transport: MockWorkerTransport | undefined): Promise<void> {
	transport?.writeEvent({ type: "agent_settled" });
	await waitForMicrotasks();
	await waitForMicrotasks();
}

function createMockWorkerManager(options?: ConstructorParameters<typeof MockWorkerTransport>[0]) {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport(options);
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	return { workerManager, transports };
}

async function settleWorker(workerManager: WorkerManager, workerId: string): Promise<void> {
	const transport = (workerManager as any).workers.get(workerId)?.handle?.transport as MockWorkerTransport | undefined;
	await settleTransport(transport);
}

function workerSnapshot(workerId: string, status: WorkerRuntimeState["status"], usage: WorkerRuntimeState["usage"]): WorkerRuntimeState {
	return {
		workerId,
		profileName: "reviewer",
		sessionMode: "worker",
		status,
		requestedThinkingLevel: "medium",
		effectiveThinkingLevel: "medium",
		startedAt: 1,
		lastEventAt: 1,
		pendingRelayQuestions: [],
		usage,
	};
}

test("TeamManager delegates, tracks, pings, and cancels workers", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ promptText: "Completed runtime inspection" })));
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
	assert.equal(activePing[0]?.worker.usage.contextWindow, 200000);
	assert.equal(activePing[0]?.worker.usage.contextRemainingTokens, 199985);

	const messaged = await teamManager.messageWorker(worker.workerId, "Focus only on abort handling", "steer");
	assert.equal(messaged.worker.workerId, worker.workerId);

	const cancelled = await teamManager.cancelWorker(worker.workerId);
	assert.equal(cancelled.worker.status, "exited");
});

test("TeamManager rolls back worker and task registry when configured rpc command fails to launch", async () => {
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			rpc: {
				...DEFAULT_TEAM_CONFIG.rpc,
				command: "pi-agent-team-definitely-missing-command-for-test",
			},
		},
	});

	await assert.rejects(
		teamManager.delegateTask({
			title: "Broken launch",
			goal: "Verify failed worker launch cleanup",
			profileName: "reviewer",
			cwd: process.cwd(),
		}),
		/Worker launch failed/,
	);
	await waitForMicrotasks();

	assert.deepEqual(teamManager.listWorkers(), []);
	const snapshot = teamManager.snapshot();
	assert.deepEqual(Object.keys(snapshot.activeWorkers), []);
	assert.deepEqual(Object.keys(snapshot.taskRegistry), []);
});

test("TeamManager passes configured rpc command and args to fresh worker launch", async () => {
	const launches: WorkerProcessOptions[] = [];
	const workerManager = new WorkerManager((options) => {
		launches.push(options);
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		workerManager,
		config: {
			...DEFAULT_TEAM_CONFIG,
			rpc: {
				...DEFAULT_TEAM_CONFIG.rpc,
				command: "node",
				args: ["dist/cli.js", "--mode", "rpc", "--no-session"],
			},
		},
	});

	await teamManager.delegateTask({
		title: "Custom RPC launch",
		goal: "Use configured rpc command",
		profileName: "reviewer",
		cwd: process.cwd(),
		projectTrusted: true,
		projectTrustRoot: process.cwd(),
	});

	assert.equal(launches[0]?.command, "node");
	assert.deepEqual(launches[0]?.baseArgs, ["dist/cli.js", "--mode", "rpc", "--no-session"]);
	assert.equal(launches[0]?.projectTrust, "approve");
});

test("TeamManager passes configured profile extensions to fresh worker launch", async () => {
	const launches: WorkerProcessOptions[] = [];
	const workerManager = new WorkerManager((options) => {
		launches.push(options);
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		workerManager,
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "reviewer"
					? {
						...profile,
						extensions: ["npm:@org/pi-provider", "/tmp/provider.ts"],
					}
					: profile,
			),
		},
	});

	await teamManager.delegateTask({
		title: "Provider extension launch",
		goal: "Use configured provider extensions",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	assert.deepEqual(launches[0]?.workerExtensions, ["npm:@org/pi-provider", "/tmp/provider.ts"]);
});

test("TeamManager delegates using configured profile overrides instead of packaged defaults", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const reviewer = resolveProfile("reviewer");
	const teamManager = new TeamManager({
		workerManager,
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "reviewer"
					? {
						...reviewer,
						tools: ["read"],
					}
					: profile,
			),
		},
	});

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Restricted reviewer",
				goal: "Use configured profile override",
				profileName: "reviewer",
				cwd: process.cwd(),
				tools: ["read", "bash"],
			}),
		/configured tool set/,
	);
});

test("wait, result readiness, terminal notification, and reuse stay blocked until agent_settled", async () => {
	let transport: MockWorkerTransport | undefined;
	const workerManager = new WorkerManager(() => {
		transport = new MockWorkerTransport({
			autoCompletePrompt: false,
			promptText: "<final_answer>headline: settled result</final_answer>",
		});
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });
	let terminalTransitions = 0;
	teamManager.onStateChange((state) => {
		const status = state.activeWorkers.w1?.status;
		if (status && ["idle", "completed", "aborted", "error", "exited"].includes(status)) terminalTransitions += 1;
	});

	const { worker } = await teamManager.delegateTask({
		title: "Wait test",
		goal: "Exercise the settlement boundary",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	transport?.completePrompt();
	await waitForMicrotasks();
	await waitForMicrotasks();
	assert.equal(teamManager.getWorkerStatus(worker.workerId)?.status, "running");
	assert.equal(terminalTransitions, 0, "completion notification inputs must remain unavailable after agent_end");
	assert.equal((await teamManager.waitForTerminal([worker.workerId], { timeoutMs: 20 })).reason, "timeout");
	assert.equal(teamManager.getWorkerResult(worker.workerId)?.worker.status, "running");
	await assert.rejects(
		teamManager.delegateTask({
			title: "Too early",
			goal: "reuse must wait for settlement",
			profileName: "reviewer",
			cwd: process.cwd(),
			reuseWorkerId: worker.workerId,
		}),
		/Cannot reuse worker.*running/,
	);

	const pending = teamManager.waitForTerminal([worker.workerId], { timeoutMs: 500 });
	transport?.writeEvent({ type: "agent_start" });
	transport?.writeEvent({ type: "agent_end", messages: [] });
	assert.equal((await teamManager.waitForTerminal([worker.workerId], { timeoutMs: 20 })).reason, "timeout");
	await settleTransport(transport);
	const resolved = await pending;
	assert.equal(resolved.reason, "all_terminal");
	assert.equal(resolved.workers[0]?.status, "idle");
	assert.equal(terminalTransitions, 1, "retry/follow-up event gaps must emit one completion only");

	const reused = await teamManager.delegateTask({
		title: "After settlement",
		goal: "reuse is available now",
		profileName: "reviewer",
		cwd: process.cwd(),
		reuseWorkerId: worker.workerId,
	});
	assert.equal(reused.worker.workerId, worker.workerId);
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
	await settleTransport(transports[0]);
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
	await settleTransport(transports[0]);

	const whileIdle = await teamManager.messageWorker(worker.workerId, "also check tests", "auto");
	assert.equal(whileIdle.delivery, "prompt");
	assert.equal(transports[0]?.commands.at(-2)?.type, "prompt");

	transports[0]?.completePrompt();
	await settleTransport(transports[0]);

	const explicitFollowUpOnIdle = await teamManager.messageWorker(worker.workerId, "one more nudge", "follow_up");
	assert.equal(
		explicitFollowUpOnIdle.delivery,
		"prompt",
		"explicit follow_up targeting an idle worker should still upgrade to prompt so the session wakes",
	);
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
	await settleTransport(transports[1]);

	const broadcast = await teamManager.messageAllWorkers("remember the spec link", "auto");
	assert.equal(broadcast.length, 2);
	const byId = new Map(broadcast.map((r) => [r.worker.workerId, r]));
	assert.equal(byId.get(first.worker.workerId)?.delivery, "steer");
	assert.equal(byId.get(second.worker.workerId)?.delivery, "prompt");
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
	const removed = await teamManager.pruneTerminalWorkers();
	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.workerId, doomed.worker.workerId);
	const remaining = teamManager.listWorkers();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]?.workerId, live.worker.workerId);
});

test("pruneTerminalWorkers retains terminal worker usage exactly once", async () => {
	const teamManager = new TeamManager();
	const state = createDefaultTeamState();
	state.activeWorkers["w1"] = workerSnapshot("w1", "idle", {
		turns: 2,
		inputTokens: 100,
		outputTokens: 40,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		costUsd: 0.25,
	});
	state.activeWorkers["w2"] = workerSnapshot("w2", "running", {
		turns: 3,
		inputTokens: 200,
		outputTokens: 80,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		costUsd: 0.5,
	});
	teamManager.restore(state);

	const removed = await teamManager.pruneTerminalWorkers();
	const afterFirstPrune = teamManager.snapshot();
	const afterNoopPrune = await teamManager.pruneTerminalWorkers();
	const aggregate = teamManager.aggregateUsage();

	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.workerId, "w1");
	assert.equal(afterFirstPrune.activeWorkers["w1"], undefined);
	assert.equal(afterFirstPrune.activeWorkers["w2"]?.status, "running");
	assert.equal(afterNoopPrune.length, 0);
	assert.deepEqual(afterFirstPrune.prunedWorkerUsageTotals, {
		workers: 1,
		turns: 2,
		inputTokens: 100,
		outputTokens: 40,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		costUsd: 0.25,
		contextTokens: 0,
	});
	assert.equal(aggregate.workers, 2);
	assert.equal(aggregate.inputTokens, 300);
	assert.equal(aggregate.outputTokens, 120);
	assert.equal(aggregate.costUsd, 0.75);
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

test("active ping returns restored exited registry snapshots without requiring WorkerManager records", async () => {
	const teamManager = new TeamManager();
	const state = createDefaultTeamState();
	state.activeWorkers["w1"] = {
		...workerSnapshot("w1", "exited", {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		}),
		error: "Pi Agents Team session restored; relaunch required for live worker control.",
	};
	teamManager.restore(state);

	const results = await teamManager.pingWorkers({ mode: "active" });

	assert.equal(results.length, 1);
	assert.equal(results[0]?.worker.workerId, "w1");
	const snapshot = teamManager.snapshot().activeWorkers.w1;
	assert.equal(results[0]?.worker.status, "exited");
	assert.match(results[0]?.worker.error ?? "", /registry snapshot|not attached/i);
	assert.ok(results[0]?.worker.lastSummary, "active ping should return a usable summary for registry-only workers");
	assert.match(snapshot?.error ?? "", /registry snapshot|not attached/i);
	assert.match(snapshot?.lastSummary?.headline ?? "", /registry snapshot|not attached/i);
});

test("active ping refreshes live workers when restored stale workers are registry-only", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ sessionStats: {
		sessionId: "live-session",
		totalMessages: 4,
		tokens: { input: 111, output: 22, cacheRead: 0, cacheWrite: 0, total: 133 },
		cost: 0.5,
		contextUsage: { tokens: 133, contextWindow: 200000, percent: 0.07 },
	} })));
	const teamManager = new TeamManager({ workerManager });
	const state = createDefaultTeamState();
	state.activeWorkers["w1"] = {
		...workerSnapshot("w1", "exited", {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		}),
		error: "Pi Agents Team session restored; relaunch required for live worker control.",
	};
	teamManager.restore(state);
	const live = await teamManager.delegateTask({
		title: "Live worker",
		goal: "stay refreshable",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await waitForMicrotasks();

	const results = await teamManager.pingWorkers({ mode: "active" });
	const stale = results.find((result) => result.worker.workerId === "w1");
	const refreshed = results.find((result) => result.worker.workerId === live.worker.workerId);

	assert.equal(results.length, 2);
	assert.equal(stale?.worker.status, "exited");
	assert.match(stale?.worker.error ?? "", /restored|registry snapshot|not attached/i);
	assert.equal(refreshed?.worker.usage.inputTokens, 111);
	assert.equal(refreshed?.worker.usage.outputTokens, 22);
});

test("active ping times out stuck refreshes, surfaces warning in snapshots, and reuses in-flight refresh", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager, activePingTimeoutMs: 5 });
	const delegated = await teamManager.delegateTask({
		title: "Stuck refresh",
		goal: "simulate a hung RPC refresh",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	let refreshCalls = 0;
	(workerManager as unknown as { refreshState: (workerId: string) => Promise<unknown> }).refreshState = async () => {
		refreshCalls += 1;
		return new Promise(() => {});
	};

	const first = await teamManager.pingWorkers({ workerIds: [delegated.worker.workerId], mode: "active" });
	const snapshotAfterFirst = teamManager.snapshot().activeWorkers[delegated.worker.workerId];
	const second = await teamManager.pingWorkers({ workerIds: [delegated.worker.workerId], mode: "active" });
	const third = await teamManager.pingWorkers({ workerIds: [delegated.worker.workerId], mode: "active" });
	const snapshotAfterThird = teamManager.snapshot().activeWorkers[delegated.worker.workerId];

	assert.equal(refreshCalls, 1);
	assert.match(first[0]?.worker.error ?? "", /timed out/i);
	assert.match(snapshotAfterFirst?.error ?? "", /timed out/i);
	assert.match(snapshotAfterFirst?.lastSummary?.headline ?? "", /timed out/i);
	assert.match(second[0]?.worker.error ?? "", /timed out/i);
	assert.match(third[0]?.worker.error ?? "", /timed out/i);
	assert.match(snapshotAfterThird?.lastSummary?.headline ?? "", /timed out/i);
});

test("active ping does not make stale terminal workers reappear in the widget", async () => {
	const originalDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const { workerManager, transports } = createMockWorkerManager();
		const teamManager = new TeamManager({ workerManager });

		await teamManager.delegateTask({
			title: "Old finished task",
			goal: "finish before the overlay opens",
			profileName: "reviewer",
			cwd: process.cwd(),
		});
		await waitForMicrotasks();
		await settleTransport(transports[0]);

		const beforePing = teamManager.getWorkerStatus("w1");
		assert.equal(beforePing?.status, "idle");
		assert.equal(beforePing?.lastEventAt, 1_000);

		now += 10 * 60 * 1_000;
		await teamManager.pingWorkers({ mode: "active" });

		const afterPing = teamManager.getWorkerStatus("w1");
		assert.equal(afterPing?.lastEventAt, beforePing?.lastEventAt);
		const plainLines = buildTeamWidgetLines(teamManager.snapshot(), { now }).join("\n");
		assert.ok(!plainLines.includes("(w1)"), `stale terminal worker should stay hidden after active ping; got:\n${plainLines}`);
		assert.match(plainLines, /1 old hidden/);
	} finally {
		Date.now = originalDateNow;
	}
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

test("TeamManager resolves launch profiles from the active config instead of packaged profile loader", async () => {
	const captured: { model?: string; systemPromptPath?: string; tools?: string[] }[] = [];
	const workerManager = new WorkerManager((options) => {
		captured.push({ model: options.model, systemPromptPath: options.systemPromptPath, tools: options.tools });
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "reviewer"
					? {
						...profile,
						model: "project/reviewer-model",
						tools: ["read", "bash"],
						promptPath: "/tmp/project-prompts/reviewer.md",
					}
					: profile),
		},
		workerManager,
	});

	await teamManager.delegateTask({
		title: "Use active config",
		goal: "Verify active session config is authoritative",
		profileName: "reviewer",
		cwd: process.cwd(),
		orchestratorModel: "orchestrator/fallback-model",
	});

	assert.equal(captured[0]?.model, "project/reviewer-model");
	assert.equal(captured[0]?.systemPromptPath, "/tmp/project-prompts/reviewer.md");
	assert.deepEqual(captured[0]?.tools, ["read", "bash"]);
});

test("TeamManager lets explicit systemPromptPath override the active role prompt path", async () => {
	const captured: Array<{ systemPromptPath?: string }> = [];
	const workerManager = new WorkerManager((options) => {
		captured.push({ systemPromptPath: options.systemPromptPath });
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "reviewer"
					? { ...profile, promptPath: "/tmp/project-prompts/reviewer.md" }
					: profile),
		},
		workerManager,
	});

	await teamManager.delegateTask({
		title: "Explicit prompt path",
		goal: "tool prompt override wins over role prompt path",
		profileName: "reviewer",
		cwd: process.cwd(),
		systemPromptPath: "./custom/reviewer.md",
	});

	assert.equal(captured[0]?.systemPromptPath, join(process.cwd(), "custom", "reviewer.md"));
});

test("TeamManager applies model precedence: tool param, role model, orchestrator model, then Pi default", async () => {
	const captures: Array<{ model?: string }> = [];
	const workerManager = new WorkerManager((options) => {
		captures.push({ model: options.model });
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "oracle" ? { ...profile, model: "role/oracle-model" } : profile),
		},
		workerManager,
	});

	await teamManager.delegateTask({
		title: "Explicit model",
		goal: "tool param wins",
		profileName: "reviewer",
		cwd: process.cwd(),
		model: "tool/override-model",
		orchestratorModel: "orchestrator/fallback-model",
	});
	await teamManager.delegateTask({
		title: "Role model",
		goal: "role model wins over orchestrator model",
		profileName: "oracle",
		cwd: process.cwd(),
		orchestratorModel: "orchestrator/fallback-model",
	});
	await teamManager.delegateTask({
		title: "Orchestrator model",
		goal: "orchestrator model wins when role has none",
		profileName: "reviewer",
		cwd: process.cwd(),
		orchestratorModel: "orchestrator/fallback-model",
	});
	await teamManager.delegateTask({
		title: "Pi default",
		goal: "undefined leaves Pi to choose its default model",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	assert.equal(captures[0]?.model, "tool/override-model");
	assert.equal(captures[1]?.model, "role/oracle-model");
	assert.equal(captures[2]?.model, "orchestrator/fallback-model");
	assert.equal(captures[3]?.model, undefined);
});

test("TeamManager applies thinking level precedence: tool param, role level, orchestrator level, then medium", async () => {
	const captures: Array<{ thinkingLevel?: string }> = [];
	const workerManager = new WorkerManager((options) => {
		captures.push({ thinkingLevel: options.thinkingLevel });
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) => {
				if (profile.name === "oracle") return { ...profile, thinkingLevel: "high" };
				if (profile.name === "reviewer") return { ...profile, thinkingLevel: undefined as never };
				return profile;
			}),
		},
		workerManager,
	});

	await teamManager.delegateTask({
		title: "Explicit thinking",
		goal: "tool param wins",
		profileName: "reviewer",
		cwd: process.cwd(),
		thinkingLevel: "low",
		orchestratorThinkingLevel: "xhigh",
	});
	await teamManager.delegateTask({
		title: "Role thinking",
		goal: "role thinking wins over orchestrator thinking",
		profileName: "oracle",
		cwd: process.cwd(),
		orchestratorThinkingLevel: "xhigh",
	});
	await teamManager.delegateTask({
		title: "Orchestrator thinking",
		goal: "orchestrator thinking wins when role has none",
		profileName: "reviewer",
		cwd: process.cwd(),
		orchestratorThinkingLevel: "xhigh",
	});
	await teamManager.delegateTask({
		title: "Default thinking",
		goal: "undefined falls back to medium",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	assert.equal(captures[0]?.thinkingLevel, "low");
	assert.equal(captures[1]?.thinkingLevel, "high");
	assert.equal(captures[2]?.thinkingLevel, "xhigh");
	assert.equal(captures[3]?.thinkingLevel, "medium");
});

test("TeamManager maps same-project trust decisions to worker launch overrides", async () => {
	const captures: Array<{ projectTrust?: string }> = [];
	const workerManager = new WorkerManager((options) => {
		captures.push({ projectTrust: options.projectTrust });
		return new MockWorkerHandle(new MockWorkerTransport());
	});
	const teamManager = new TeamManager({ workerManager });
	const projectRoot = process.cwd();

	await teamManager.delegateTask({
		title: "Trusted worker",
		goal: "same project gets approve",
		profileName: "reviewer",
		cwd: projectRoot,
		projectTrusted: true,
		projectTrustRoot: projectRoot,
	});
	await teamManager.delegateTask({
		title: "Untrusted worker",
		goal: "same project gets no-approve",
		profileName: "reviewer",
		cwd: projectRoot,
		projectTrusted: false,
		projectTrustRoot: projectRoot,
	});
	await teamManager.delegateTask({
		title: "Unknown worker",
		goal: "old Pi gets no trust flag",
		profileName: "reviewer",
		cwd: projectRoot,
	});
	await teamManager.delegateTask({
		title: "Outside project worker",
		goal: "do not approve unrelated cwd",
		profileName: "reviewer",
		cwd: join(projectRoot, "..", "outside-project"),
		projectTrusted: true,
		projectTrustRoot: projectRoot,
	});

	assert.equal(captures[0]?.projectTrust, "approve");
	assert.equal(captures[1]?.projectTrust, "no-approve");
	assert.equal(captures[2]?.projectTrust, undefined);
	assert.equal(captures[3]?.projectTrust, undefined);
});

async function createIdleReusableTeam(sessionStats?: Record<string, unknown> | (() => Record<string, unknown>), rejectSessionStats?: string) {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport({ sessionStats, rejectSessionStats });
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });
	const first = await teamManager.delegateTask({
		title: "First",
		goal: "first reusable task",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleTransport(transports[0]);
	assert.equal(teamManager.getWorkerStatus(first.worker.workerId)?.status, "idle");
	return { teamManager, transports, workerId: first.worker.workerId };
}

test("delegateTask with reuseWorkerId refreshes context and allows reuse below saturation thresholds", async () => {
	const { teamManager, transports, workerId } = await createIdleReusableTeam({
		sessionId: "mock-session",
		totalMessages: 1,
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		cost: 0.01,
		contextUsage: { tokens: 99000, contextWindow: 200000, percent: 49.5 },
	});

	const reused = await teamManager.delegateTask({
		title: "Second",
		goal: "below threshold reuse",
		profileName: "reviewer",
		cwd: process.cwd(),
		reuseWorkerId: workerId,
	});

	assert.equal(reused.worker.workerId, workerId);
	assert.equal(reused.worker.usage.contextPercent, 49.5);
	assert.equal(reused.worker.usage.contextRemainingTokens, 101000);
	assert.deepEqual(transports[0]?.commands.map((command) => command.type).slice(-2), ["get_session_stats", "prompt"]);
});

test("delegateTask with reuseWorkerId rejects saturated context percent before prompting", async () => {
	const { teamManager, transports, workerId } = await createIdleReusableTeam({
		sessionId: "mock-session",
		totalMessages: 1,
		contextUsage: { tokens: 160000, contextWindow: 200000, percent: 80 },
	});

	await assert.rejects(
		() => teamManager.delegateTask({
			title: "Second",
			goal: "saturated percent reuse",
			profileName: "reviewer",
			cwd: process.cwd(),
			reuseWorkerId: workerId,
		}),
		/Cannot reuse worker .*contextPercent=80%.*contextRemainingTokens=40000.*Delegate fresh/,
	);
	assert.equal(transports[0]?.commands.filter((command) => command.type === "prompt").length, 1);
});

test("delegateTask with reuseWorkerId rejects low remaining context before prompting", async () => {
	const { teamManager, transports, workerId } = await createIdleReusableTeam({
		sessionId: "mock-session",
		totalMessages: 1,
		contextUsage: { tokens: 167232, contextWindow: 200000, percent: 70 },
	});

	await assert.rejects(
		() => teamManager.delegateTask({
			title: "Second",
			goal: "low remaining reuse",
			profileName: "reviewer",
			cwd: process.cwd(),
			reuseWorkerId: workerId,
		}),
		/Cannot reuse worker .*contextPercent=70%.*contextRemainingTokens=32768.*Delegate fresh/,
	);
	assert.equal(transports[0]?.commands.filter((command) => command.type === "prompt").length, 1);
});

test("delegateTask with reuseWorkerId allows unknown or nullable context after refresh", async () => {
	const { teamManager, workerId } = await createIdleReusableTeam({
		sessionId: "mock-session",
		totalMessages: 1,
		contextUsage: { tokens: null, contextWindow: 200000, percent: null },
	});

	const reused = await teamManager.delegateTask({
		title: "Second",
		goal: "unknown context reuse",
		profileName: "reviewer",
		cwd: process.cwd(),
		reuseWorkerId: workerId,
	});

	assert.equal(reused.worker.workerId, workerId);
	assert.equal(reused.worker.usage.contextPercent, undefined);
	assert.equal(reused.worker.usage.contextRemainingTokens, undefined);
});

test("delegateTask with reuseWorkerId clears stale context budget when refresh omits contextUsage", async () => {
	let refreshCount = 0;
	const { teamManager, workerId } = await createIdleReusableTeam(() => {
		refreshCount += 1;
		if (refreshCount === 1) {
			return {
				sessionId: "mock-session",
				totalMessages: 1,
				contextUsage: { tokens: 190000, contextWindow: 200000, percent: 95 },
			};
		}
		return {
			sessionId: "mock-session",
			totalMessages: 1,
		};
	});

	await teamManager.pingWorkers({ workerIds: [workerId], mode: "active" });
	assert.equal(teamManager.getWorkerStatus(workerId)?.usage.contextPercent, 95);

	const reused = await teamManager.delegateTask({
		title: "Second",
		goal: "absent context is unknown, not saturated",
		profileName: "reviewer",
		cwd: process.cwd(),
		reuseWorkerId: workerId,
	});

	assert.equal(reused.worker.workerId, workerId);
	assert.equal(reused.worker.usage.contextPercent, undefined);
	assert.equal(reused.worker.usage.contextRemainingTokens, undefined);
});

test("delegateTask with reuseWorkerId propagates stats refresh errors before reuse prompt", async () => {
	const { teamManager, transports, workerId } = await createIdleReusableTeam(undefined, "stats unavailable");

	await assert.rejects(
		() => teamManager.delegateTask({
			title: "Second",
			goal: "refresh fails",
			profileName: "reviewer",
			cwd: process.cwd(),
			reuseWorkerId: workerId,
		}),
		/stats unavailable/,
	);
	assert.equal(transports[0]?.commands.filter((command) => command.type === "prompt").length, 1);
});

test("delegateTask with reuseWorkerId routes to reuse path on idle worker, allocates a fresh taskId, and reuses the same handle", async () => {
	const transports: MockWorkerTransport[] = [];
	const handles: MockWorkerHandle[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport();
		transports.push(transport);
		const handle = new MockWorkerHandle(transport);
		handles.push(handle);
		return handle;
	});
	const teamManager = new TeamManager({ workerManager });

	const first = await teamManager.delegateTask({
		title: "First",
		goal: "first task",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleTransport(transports[0]);

	const second = await teamManager.delegateTask({
		title: "Second",
		goal: "second task on the same worker",
		profileName: "reviewer",
		cwd: process.cwd(),
		reuseWorkerId: first.worker.workerId,
	});

	assert.equal(handles.length, 1, "reuse should not spawn a second handle");
	assert.equal(second.worker.workerId, first.worker.workerId);
	assert.notEqual(second.task?.taskId, first.task?.taskId);
	assert.equal(transports[0]?.commands.filter((c) => c.type === "prompt").length, 2);
});

test("delegateTask with reuseWorkerId rejects when inherited orchestrator thinking level differs", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({
		config: {
			...DEFAULT_TEAM_CONFIG,
			profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
				profile.name === "reviewer"
					? { ...profile, thinkingLevel: undefined as never }
					: profile),
		},
		workerManager,
	});

	const first = await teamManager.delegateTask({
		title: "First",
		goal: "first task with inherited thinking level",
		profileName: "reviewer",
		cwd: process.cwd(),
		orchestratorThinkingLevel: "low",
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, first.worker.workerId);

	await teamManager.delegateTask({
		title: "Reuse same inherited level",
		goal: "should reuse because launch thinking level is unchanged",
		profileName: "reviewer",
		cwd: process.cwd(),
		orchestratorThinkingLevel: "low",
		reuseWorkerId: first.worker.workerId,
	});
	await settleWorker(workerManager, first.worker.workerId);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse changed inherited level",
				goal: "should reject because launch thinking level changes",
				profileName: "reviewer",
				cwd: process.cwd(),
				orchestratorThinkingLevel: "xhigh",
				reuseWorkerId: first.worker.workerId,
			}),
		/launch settings differ.*thinkingLevel/,
	);
});

test("delegateTask with reuseWorkerId rejects unknown / running / exited targets", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Unknown",
				goal: "unknown reuse target",
				profileName: "reviewer",
				cwd: process.cwd(),
				reuseWorkerId: "ghost",
			}),
		/Unknown workerId/,
	);

	const running = await teamManager.delegateTask({
		title: "Running",
		goal: "stays running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse running",
				goal: "should fail",
				profileName: "reviewer",
				cwd: process.cwd(),
				reuseWorkerId: running.worker.workerId,
			}),
		/Cannot reuse worker/,
	);

	await teamManager.cancelWorker(running.worker.workerId);
	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse exited",
				goal: "should fail",
				profileName: "reviewer",
				cwd: process.cwd(),
				reuseWorkerId: running.worker.workerId,
			}),
		/RPC session is already disposed|launch a new one/,
	);
});

test("delegateTask with reuseWorkerId rejects when launch-affecting fields differ (model)", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const first = await teamManager.delegateTask({
		title: "First",
		goal: "first task with model A",
		profileName: "reviewer",
		cwd: process.cwd(),
		model: "provider/model-a",
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, first.worker.workerId);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse with different model",
				goal: "should reject",
				profileName: "reviewer",
				cwd: process.cwd(),
				model: "provider/model-b",
				reuseWorkerId: first.worker.workerId,
			}),
		/launch settings differ.*model/,
	);
});

test("delegateTask with reuseWorkerId rejects when project trust launch override differs", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const projectRoot = process.cwd();

	const first = await teamManager.delegateTask({
		title: "Trusted first",
		goal: "launch with project trust approve",
		profileName: "reviewer",
		cwd: projectRoot,
		projectTrusted: true,
		projectTrustRoot: projectRoot,
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, first.worker.workerId);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Untrusted reuse",
				goal: "should reject because --approve vs --no-approve differs",
				profileName: "reviewer",
				cwd: projectRoot,
				projectTrusted: false,
				projectTrustRoot: projectRoot,
				reuseWorkerId: first.worker.workerId,
			}),
		/launch settings differ.*projectTrust.*approve.*no-approve/,
	);
});

test("delegateTask with reuseWorkerId rejects when rpc command or args differ", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const config = {
		...DEFAULT_TEAM_CONFIG,
		rpc: {
			...DEFAULT_TEAM_CONFIG.rpc,
			command: "pi-a",
			args: ["--mode", "rpc", "--no-session"],
		},
	};
	const teamManager = new TeamManager({ workerManager, config });

	const first = await teamManager.delegateTask({
		title: "First launch",
		goal: "capture initial rpc settings",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, first.worker.workerId);

	config.rpc.command = "pi-b";
	config.rpc.args = ["--mode", "rpc", "--no-session", "--custom"];

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse with changed rpc settings",
				goal: "should reject because process launch args changed",
				profileName: "reviewer",
				cwd: process.cwd(),
				reuseWorkerId: first.worker.workerId,
			}),
		/launch settings differ.*command.*baseArgs/,
	);
});

test("delegateTask with reuseWorkerId rejects when worker extensions differ", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const config = {
		...DEFAULT_TEAM_CONFIG,
		profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
			profile.name === "reviewer"
				? {
					...profile,
					extensions: ["npm:@org/provider-a"],
				}
				: profile,
		),
	};
	const teamManager = new TeamManager({ workerManager, config });

	const first = await teamManager.delegateTask({
		title: "First provider launch",
		goal: "capture initial provider extensions",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, first.worker.workerId);

	const reviewer = config.profiles.find((profile) => profile.name === "reviewer");
	assert.ok(reviewer);
	reviewer.extensions = ["npm:@org/provider-b"];

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse with changed provider extension",
				goal: "should reject because provider extension set changed",
				profileName: "reviewer",
				cwd: process.cwd(),
				reuseWorkerId: first.worker.workerId,
			}),
		/launch settings differ.*workerExtensions/,
	);
});

test("delegateTask with reuseWorkerId rejects when skills/tools/cwd differ", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const noSkills = await teamManager.delegateTask({
		title: "No skills",
		goal: "launched without skills",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, noSkills.worker.workerId);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse with skills",
				goal: "should reject — process launched with --no-skills",
				profileName: "reviewer",
				cwd: process.cwd(),
				skills: ["some-skill"],
				reuseWorkerId: noSkills.worker.workerId,
			}),
		/launch settings differ.*skills/,
	);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Reuse with cwd",
				goal: "should reject",
				profileName: "reviewer",
				cwd: "/tmp/other-dir",
				reuseWorkerId: noSkills.worker.workerId,
			}),
		/launch settings differ.*cwd/,
	);
});

test("delegateTask with reuseWorkerId rejects cross-profile reuse", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });

	const reviewer = await teamManager.delegateTask({
		title: "Reviewer first",
		goal: "establish reviewer worker",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, reviewer.worker.workerId);

	await assert.rejects(
		() =>
			teamManager.delegateTask({
				title: "Wrong profile",
				goal: "try to reuse with different role",
				profileName: "fixer",
				cwd: process.cwd(),
				reuseWorkerId: reviewer.worker.workerId,
			}),
		/profile is reviewer/,
	);
});

test("closeWorker disposes idle worker, marks exited; rejects running workers", async () => {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport({ autoCompletePrompt: false })));
	const teamManager = new TeamManager({ workerManager });

	const idle = await teamManager.delegateTask({
		title: "Idle",
		goal: "will idle quickly",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	// flip to idle by completing
	const transport = (workerManager as any).workers.get(idle.worker.workerId)?.handle?.transport as MockWorkerTransport;
	transport?.completePrompt();
	await settleTransport(transport);
	assert.equal(teamManager.getWorkerStatus(idle.worker.workerId)?.status, "idle");

	const closed = await teamManager.closeWorker(idle.worker.workerId);
	assert.equal(closed.worker.status, "exited");

	const running = await teamManager.delegateTask({
		title: "Running",
		goal: "stays running",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await assert.rejects(
		() => teamManager.closeWorker(running.worker.workerId),
		/Cannot close worker/,
	);
});

test("pruneTerminalWorkers disposes the live RPC client of an idle worker before removal", async () => {
	const transports: MockWorkerTransport[] = [];
	const workerManager = new WorkerManager(() => {
		const transport = new MockWorkerTransport();
		transports.push(transport);
		return new MockWorkerHandle(transport);
	});
	const teamManager = new TeamManager({ workerManager });

	const idle = await teamManager.delegateTask({
		title: "Idle for prune",
		goal: "becomes idle then pruned",
		profileName: "reviewer",
		cwd: process.cwd(),
	});
	await waitForMicrotasks();
	await settleWorker(workerManager, idle.worker.workerId);
	assert.equal(teamManager.getWorkerStatus(idle.worker.workerId)?.status, "idle");
	assert.ok(workerManager.hasWorker(idle.worker.workerId));

	const removed = await teamManager.pruneTerminalWorkers();
	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.workerId, idle.worker.workerId);
	assert.ok(!workerManager.hasWorker(idle.worker.workerId), "prune must dispose the RPC handle");
	assert.equal(teamManager.listWorkers().length, 0);
});

test("messageWorker rejects messages to terminal workers with a clear error", async () => {
	// cr-expert P2-12: previously, calling messageWorker on an aborted/exited
	// worker would resolve delivery to "prompt", which promptWorker then ran
	// against a disposed RPC client — briefly flipping the dashboard to
	// "running" before throwing a confusing low-level error. Now we reject
	// early with a clear message pointing at re-delegate + prune.
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	const delegated = await teamManager.delegateTask({
		title: "Short",
		goal: "Short task",
		profileName: "reviewer",
		cwd: process.cwd(),
		contextHints: [],
	});
	await waitForMicrotasks();
	await teamManager.cancelWorker(delegated.worker.workerId);

	await assert.rejects(
		() => teamManager.messageWorker(delegated.worker.workerId, "still there?"),
		/already disposed|cannot receive|Re-delegate/i,
	);
});
