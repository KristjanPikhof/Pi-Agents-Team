import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createDefaultTeamState } from "../../src/config";
import type { TeamManager } from "../../src/control-plane/team-manager";
import { createTeamDashboardOverlayComponent, openTeamDashboardOverlay, TEAM_DASHBOARD_OVERLAY_OPTIONS } from "../../src/ui/overlay";
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

function makeManager(state: PersistedTeamState, transcriptMap: Record<string, string> = {}): TeamManager {
	return {
		snapshot: () => state,
		pingWorkers: async () => undefined,
		getWorkerTranscript: (workerId: string) => transcriptMap[workerId],
		getWorkerConsole: () => [],
	} as unknown as TeamManager;
}

function makeComponent(options: {
	state?: PersistedTeamState;
	rows?: number;
	cols?: number;
	initialWorkerId?: string;
	transcripts?: Record<string, string>;
}) {
	const state = options.state ?? makeState();
	const tui = {
		terminal: { rows: options.rows ?? 30, columns: options.cols ?? 100 },
		requestRender: () => {},
	};
	const manager = makeManager(state, options.transcripts);
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

test("wide terminals render a split roster and inspector shell", () => {
	const { component } = makeComponent({ rows: 32, cols: 140, initialWorkerId: "w1" });
	const lines = component.render(140);
	assert.ok(lines.some((line) => line.includes("Workers") && line.includes("│") && line.includes("Inspector")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 140, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
});

test("selection survives direct open, refresh, and escape back to list", async () => {
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
	assert.ok(lines.some((line) => line.includes("status=idle") || line.includes("w2 · fixer:idle")));

	component.handleInput("\x1b");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Selected: w2")));
	assert.ok(lines.some((line) => line.includes("focus=list")));
});

test("page keys use visible page size and tab/shift-tab cycle detail tabs", () => {
	const transcripts = {
		w1: Array.from({ length: 200 }, (_, index) => `detail line ${index + 1}`).join("\n"),
	};
	const { component } = makeComponent({ rows: 24, cols: 100, initialWorkerId: "w1", transcripts });

	let lines = component.render(100);
	const before = lines.find((line) => line.startsWith("Scroll "));
	assert.ok(before);
	assert.ok(lines.some((line) => line.includes("[Summary] Console")));

	component.handleInput("\t");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("Summary [Console]")));

	component.handleInput("\x1b[Z");
	lines = component.render(100);
	assert.ok(lines.some((line) => line.includes("[Summary] Console")));

	component.handleInput("\x1b[6~");
	lines = component.render(100);
	const after = lines.find((line) => line.startsWith("Scroll "));
	assert.ok(after);
	assert.notEqual(after, before, "expected page down to move by the rendered page size");
	assert.match(after!, /Scroll 1[0-9]-/);
});
