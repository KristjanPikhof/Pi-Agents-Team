import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createDefaultTeamState } from "../../src/config";
import type { TeamManager } from "../../src/control-plane/team-manager";
import { createTeamDashboardOverlayComponent, openTeamDashboardOverlay, TEAM_DASHBOARD_OVERLAY_OPTIONS } from "../../src/ui/overlay";
import type { WorkerConsoleEvent } from "../../src/runtime/worker-manager";
import type { PersistedTeamState, WorkerRuntimeState, WorkerStatus } from "../../src/types";

function makeWorker(overrides: Partial<WorkerRuntimeState> & { workerId: string; status: WorkerStatus }): WorkerRuntimeState {
	return {
		workerId: overrides.workerId,
		profileName: overrides.profileName ?? "reviewer",
		sessionMode: "worker",
		status: overrides.status,
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
		...overrides,
	};
}

function makeState(workerCount = 2): PersistedTeamState {
	const state = createDefaultTeamState();
	for (let index = 1; index <= workerCount; index += 1) {
		const workerId = `w${index}`;
		state.activeWorkers[workerId] = makeWorker({
			workerId,
			status: "running",
			profileName: index % 2 === 0 ? "fixer" : "reviewer",
			currentTask: {
				taskId: `t${index}`,
				title: `Task ${index}`,
				goal: `Goal ${index}`,
				requestedBy: "orchestrator",
				profileName: index % 2 === 0 ? "fixer" : "reviewer",
				cwd: process.cwd(),
				contextHints: [],
				createdAt: Date.now(),
			},
			lastSummary: {
				workerId,
				taskId: `t${index}`,
				headline: `headline ${index}`,
				status: "running",
				readFiles: [],
				changedFiles: [],
				risks: [],
				relayQuestionCount: 0,
				updatedAt: Date.now(),
			},
		});
	}
	return state;
}

function makeManager(
	state: PersistedTeamState,
	transcriptMap: Record<string, string> = {},
	consoleMap: Record<string, WorkerConsoleEvent[]> = {},
): TeamManager {
	return {
		snapshot: () => state,
		pingWorkers: async () => undefined,
		getWorkerTranscript: (workerId: string) => transcriptMap[workerId],
		getWorkerConsole: (workerId: string) => consoleMap[workerId] ?? [],
	} as unknown as TeamManager;
}

function makeComponent(options: {
	state?: PersistedTeamState;
	rows?: number;
	cols?: number;
	initialWorkerId?: string;
	transcripts?: Record<string, string>;
	consoles?: Record<string, WorkerConsoleEvent[]>;
}) {
	const state = options.state ?? makeState();
	const tui = {
		terminal: { rows: options.rows ?? 30, columns: options.cols ?? 100 },
		requestRender: () => {},
	};
	const manager = makeManager(state, options.transcripts, options.consoles);
	const component = createTeamDashboardOverlayComponent(
		tui,
		manager,
		state,
		() => {},
		{ initialWorkerId: options.initialWorkerId },
	);
	return { component, state, tui, manager };
}

test("openTeamDashboardOverlay uses the widened responsive overlay options", async () => {
	const state = makeState();
	const manager = makeManager(state);
	let capturedOptions: unknown;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
				capturedOptions = customOptions;
				factory({ terminal: { rows: 30, columns: 120 }, requestRender: () => {} }, {}, {}, () => {});
			},
		},
	} as any;

	await openTeamDashboardOverlay(ctx, manager);
	assert.deepEqual((capturedOptions as { overlayOptions: unknown }).overlayOptions, TEAM_DASHBOARD_OVERLAY_OPTIONS);
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.width, "76%");
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight, "90%");
});

test("detail viewport height grows with terminal rows instead of a fixed body budget", () => {
	const transcripts = {
		w1: Array.from({ length: 120 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n"),
	};
	const small = makeComponent({ rows: 20, cols: 100, initialWorkerId: "w1", transcripts });
	const large = makeComponent({ rows: 40, cols: 100, initialWorkerId: "w1", transcripts });

	const smallLines = small.component.render(100);
	const largeLines = large.component.render(100);

	assert.ok(largeLines.length > smallLines.length, `expected more visible lines for taller terminal (${smallLines.length} vs ${largeLines.length})`);
	assert.ok(smallLines.some((line) => line.includes("Scroll ")));
	assert.ok(largeLines.some((line) => line.includes("Scroll ")));
});

test("wide terminals render grouped queue sections beside the inspector", () => {
	const state = makeState(4);
	state.activeWorkers.w1!.pendingRelayQuestions = [{
		relayId: "r1",
		workerId: "w1",
		taskId: "t1",
		question: "Need operator reply",
		assumption: "wait",
		urgency: "high",
		createdAt: Date.now(),
	}];
	state.activeWorkers.w2!.status = "error";
	state.activeWorkers.w2!.error = "rpc failed";
	state.activeWorkers.w3!.status = "running";
	state.activeWorkers.w4!.status = "idle";
	state.activeWorkers.w4!.finalAnswer = "headline: done";

	const { component } = makeComponent({ state, rows: 32, cols: 140, initialWorkerId: "w1" });
	const lines = component.render(140);
	assert.ok(lines.some((line) => line.includes("Needs reply (1)")));
	assert.ok(lines.some((line) => line.includes("Inspector") && line.includes("│")));
	assert.ok(lines.some((line) => line.includes("Needs recovery (1)")));
	assert.ok(lines.some((line) => line.includes("In progress (1)")));
	assert.ok(lines.some((line) => line.includes("Completed or idle (1)")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 140, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
});

test("overview front-loads status task needs-operator summary and usage, with deliverable before transcript", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.pendingRelayQuestions = [{
		relayId: "relay-1",
		workerId: "w1",
		taskId: "t1",
		question: "Ship now or wait for ops?",
		assumption: "wait for ops",
		urgency: "medium",
		createdAt: Date.now(),
	}];
	state.activeWorkers.w1!.usage.turns = 3;
	state.activeWorkers.w1!.usage.inputTokens = 120;
	state.activeWorkers.w1!.usage.outputTokens = 45;
	state.activeWorkers.w1!.usage.costUsd = 0.12;
	state.activeWorkers.w1!.lastSummary!.changedFiles = ["src/ui/overlay.ts"];
	state.activeWorkers.w1!.lastSummary!.risks = ["manual smoke still pending"];
	state.activeWorkers.w1!.lastSummary!.nextRecommendation = "verify in TUI";
	state.activeWorkers.w1!.finalAnswer = "headline: shipped\nchanged_files:\n- src/ui/overlay.ts";
	const transcript = "assistant transcript body";
	const consoles = {
		w1: [{ ts: 1_700_000_000_000, kind: "status", text: "running" }],
	};
	const { component } = makeComponent({ state, rows: 34, cols: 100, initialWorkerId: "w1", transcripts: { w1: transcript }, consoles });

	let lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("[Overview] Deliverable Console")));
	assert.ok(lines.some((line) => line.includes("Status")));
	assert.ok(lines.some((line) => line.includes("Needs operator")));
	assert.ok(lines.some((line) => line.includes("Latest summary")));
	assert.ok(lines.some((line) => line.includes("Usage")) || lines.some((line) => line.includes("turns=3 input=120 output=45 cost=$0.1200")));
	assert.ok(!lines.some((line) => line.includes("assistant transcript body")));

	component.handleInput("d");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Overview [Deliverable] Console")));
	const deliverableIndex = lines.findIndex((line) => line.includes("Final answer"));
	const transcriptIndex = lines.findIndex((line) => line.includes("Latest assistant text"));
	assert.ok(deliverableIndex >= 0);
	assert.ok(transcriptIndex > deliverableIndex);
	assert.ok(lines.some((line) => line.includes("headline: shipped")));

	component.handleInput("c");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Overview Deliverable [Console]")));
	assert.ok(lines.some((line) => line.includes("[status] running")));
});

test("selection survives direct open, refresh, and escape back to queue", async () => {
	const state = makeState(3);
	let pinged = 0;
	const manager = {
		snapshot: () => state,
		pingWorkers: async () => {
			pinged += 1;
			state.activeWorkers.w2!.status = "idle";
		},
		getWorkerTranscript: () => "summary body",
		getWorkerConsole: () => [],
	} as unknown as TeamManager;
	const component = createTeamDashboardOverlayComponent(
		{ terminal: { rows: 28, columns: 100 }, requestRender: () => {} },
		manager,
		state,
		() => {},
		{ initialWorkerId: "w2" },
	);

	let lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("selected=w2")));
	assert.ok(lines.some((line) => line.includes("Inspector · w2")));

	component.handleInput("r");
	await new Promise((resolve) => setImmediate(resolve));
	lines = component.render(100);
	assert.equal(pinged, 1);
	assert.ok(lines.some((line) => line.includes("selected=w2")));
	assert.ok(lines.some((line) => line.includes("fixer:idle")) || lines.some((line) => line.includes("- Status: idle")));
	const helpIndex = lines.findIndex((line) => line.includes("tab cycle tabs") || line.includes("enter inspect"));
	const statusIndex = lines.findIndex((line) => line.startsWith("» Refreshed "));
	const bodyIndex = lines.findIndex((line) => line.includes("Queue · 3 tracked") || line.includes("Inspector · w2"));
	assert.ok(helpIndex >= 0, "expected help row to stay visible in header");
	assert.ok(statusIndex >= 0, "expected refresh status row to stay visible in header");
	assert.ok(bodyIndex > statusIndex, `expected body after header (${bodyIndex} <= ${statusIndex})`);

	component.handleInput("\x1b");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Queue · 3 tracked")));
	assert.ok(lines.some((line) => line.includes("Focus: list")));
});

test("page keys use visible page size and tab or shift-tab cycle inspector tabs", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.pendingRelayQuestions = [{
		relayId: "r1",
		workerId: "w1",
		askId: "t1",
		question: "Need reply",
		assumption: "wait",
		urgency: "medium",
		createdAt: Date.now(),
	}];
	const { component } = makeComponent({ rows: 24, cols: 100, initialWorkerId: "w1" });

	let lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("[Overview] Deliverable Console")));

	component.handleInput("\t");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Overview [Deliverable] Console")));

	component.handleInput("\x1b[Z");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("[Overview] Deliverable Console")));

	const before = lines.find((line) => line.startsWith("Scroll "));
	assert.ok(before);
	component.handleInput("\x1b[6~");
	lines = component.render(100);
	const after = lines.find((line) => line.startsWith("Scroll "));
	assert.ok(after);
	assert.notEqual(after, before, "expected page down to move by the rendered page size");
});

test("narrow layouts keep help visible and enforce width while switching between queue and inspector", () => {
	const state = makeState(2);
	state.activeWorkers.w1!.lastSummary!.headline = "x".repeat(200);
	const { component } = makeComponent({ state, rows: 22, cols: 72 });

	let lines = component.render(72);
	assert.ok(lines.some((line) => line.includes("enter inspect")), "expected narrow list help row");
	assert.ok(lines.some((line) => line.includes("Queue · 2 tracked")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 72, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}

	component.handleInput("\r");
	lines = component.render(72);
	assert.ok(lines.some((line) => line.includes("g/G top/bottom")), "expected inspector help row after opening detail");
	assert.ok(lines.some((line) => line.includes("Inspector · w1")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 72, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
});
