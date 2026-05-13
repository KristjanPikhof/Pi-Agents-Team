import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDefaultTeamState } from "../../src/config";
import type { TeamManager } from "../../src/control-plane/team-manager";
import {
	buildTabBar,
	createTeamDashboardOverlayComponent,
	openTeamDashboardOverlay,
	TEAM_DASHBOARD_OVERLAY_OPTIONS,
} from "../../src/ui/overlay";
import { stripAnsi } from "../../src/ui/theme";

function plainLines(lines: string[]): string[] {
	return lines.map(stripAnsi);
}

interface OverlayComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose?(): void;
}

function renderPlain(component: OverlayComponent, width: number): string[] {
	return (component as { render(w: number): string[] }).render(width).map(stripAnsi);
}
import type { AssistantChunk, WorkerConsoleEvent } from "../../src/runtime/worker-manager";
import type { PersistedTeamState, WorkerRuntimeState, WorkerStatus } from "../../src/types";

function makeWorker(overrides: Partial<WorkerRuntimeState> & { workerId: string; status: WorkerStatus }): WorkerRuntimeState {
	return {
		workerId: overrides.workerId,
		profileName: overrides.profileName ?? "reviewer",
		sessionMode: "worker",
		status: overrides.status,
		requestedThinkingLevel: overrides.requestedThinkingLevel ?? "medium",
		effectiveThinkingLevel: overrides.effectiveThinkingLevel ?? "medium",
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

interface FakeManagerOptions {
	state: PersistedTeamState;
	transcripts?: Record<string, string>;
	consoles?: Record<string, WorkerConsoleEvent[]>;
	chunks?: Record<string, AssistantChunk[]>;
	routingMode?: "team" | "solo";
	displayCost?: boolean;
	profiles?: string[];
	calls?: FakeManagerCalls;
}

interface FakeManagerCalls {
	pings: number;
	messages: Array<{ workerId: string; message: string; delivery: string }>;
	closes: string[];
	cancels: string[];
	prunes: number;
	delegates: Array<{ profileName: string; goal: string; reuseWorkerId?: string }>;
}

function makeFakeManager(options: FakeManagerOptions): TeamManager {
	const calls = options.calls ?? {
		pings: 0,
		messages: [],
		closes: [],
		cancels: [],
		prunes: 0,
		delegates: [],
	};
	options.calls = calls;
	return {
		snapshot: () => options.state,
		pingWorkers: async () => {
			calls.pings += 1;
		},
		getWorkerTranscript: (workerId: string) => options.transcripts?.[workerId],
		getWorkerConsole: (workerId: string) => options.consoles?.[workerId] ?? [],
		getAssistantTail: (workerId: string) => options.chunks?.[workerId] ?? [],
		onAssistantChunk: () => () => {},
		messageWorker: async (workerId: string, message: string, delivery = "auto") => {
			calls.messages.push({ workerId, message, delivery });
			return { worker: options.state.activeWorkers[workerId]!, delivery };
		},
		closeWorker: async (workerId: string) => {
			calls.closes.push(workerId);
			return { worker: options.state.activeWorkers[workerId]! };
		},
		cancelWorker: async (workerId: string) => {
			calls.cancels.push(workerId);
			return { worker: options.state.activeWorkers[workerId]! };
		},
		pruneTerminalWorkers: async () => {
			calls.prunes += 1;
			return [];
		},
		delegateTask: async (request: { profileName: string; goal: string; reuseWorkerId?: string }) => {
			calls.delegates.push({ profileName: request.profileName, goal: request.goal, reuseWorkerId: request.reuseWorkerId });
			return { worker: options.state.activeWorkers[Object.keys(options.state.activeWorkers)[0]]! };
		},
		routingMode: options.routingMode ?? "team",
		displayCost: options.displayCost !== false,
		config: { profiles: (options.profiles ?? ["reviewer", "fixer"]).map((name) => ({ name })) },
	} as unknown as TeamManager;
}

function makeComponent(opts: {
	state?: PersistedTeamState;
	rows?: number;
	cols?: number;
	initialWorkerId?: string;
	transcripts?: Record<string, string>;
	consoles?: Record<string, WorkerConsoleEvent[]>;
	chunks?: Record<string, AssistantChunk[]>;
	routingMode?: "team" | "solo";
	displayCost?: boolean;
}) {
	const state = opts.state ?? makeState();
	const tui = {
		terminal: { rows: opts.rows ?? 30, columns: opts.cols ?? 100 },
		requestRender: () => {},
	};
	const managerOpts: FakeManagerOptions = {
		state,
		transcripts: opts.transcripts,
		consoles: opts.consoles,
		chunks: opts.chunks,
		routingMode: opts.routingMode,
		displayCost: opts.displayCost,
	};
	const manager = makeFakeManager(managerOpts);
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {}, {
		initialWorkerId: opts.initialWorkerId,
	});
	return { component, state, tui, manager, calls: managerOpts.calls! };
}

test("openTeamDashboardOverlay uses the widened responsive overlay options", async () => {
	const state = makeState();
	const manager = makeFakeManager({ state });
	let capturedOptions: unknown;
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			custom: async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
				capturedOptions = customOptions;
				factory({ terminal: { rows: 30, columns: 120 }, requestRender: () => {} }, {}, {}, () => {});
			},
		},
	} as any;

	await openTeamDashboardOverlay(ctx, manager);
	assert.deepEqual((capturedOptions as { overlayOptions: unknown }).overlayOptions, TEAM_DASHBOARD_OVERLAY_OPTIONS);
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.width, "50%");
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight, "90%");
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.anchor, "top-right");
});

test("buildTabBar marks the active tab and shows solo badge when routingMode=solo", () => {
	const team = buildTabBar("workers", "team");
	assert.match(team, /\[1 Workers\]/);
	assert.match(team, /2 Inspect/);
	assert.match(team, /3 Console/);
	assert.match(team, /4 Cost/);
	assert.doesNotMatch(team, /solo/);

	const solo = buildTabBar("inspect", "solo");
	assert.match(solo, /\[2 Inspect\]/);
	assert.match(solo, /solo/);
});

test("number keys 1-4 jump to each tab and tab/shift-tab cycle", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, initialWorkerId: "w1" });

	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[2 Inspect]")), "expected initial inspect tab");

	component.handleInput("3");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[3 Console]")));

	component.handleInput("4");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[4 Cost]")));

	component.handleInput("1");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[1 Workers]")));

	component.handleInput("\t");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[2 Inspect]")));

	component.handleInput("\x1b[Z");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[1 Workers]")));
});

test("workers tab renders roster sections, reuse tag for idle workers, and supports up/down selection", () => {
	const state = makeState(3);
	state.activeWorkers.w2!.status = "idle";
	state.activeWorkers.w2!.finalAnswer = "headline: done";
	const { component } = makeComponent({ state, rows: 32, cols: 100 });

	component.handleInput("1");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[reuse]")), "expected reuse hint for idle worker");
	assert.ok(lines.some((line) => line.includes("In progress")));
	assert.ok(lines.some((line) => line.includes("Completed or idle")));

	component.handleInput("j");
	component.handleInput("j");
	lines = renderPlain(component, 100);
	const selectedRow = lines.find((line) => line.includes("▶"));
	assert.ok(selectedRow, "expected selection arrow on a row");
});

test("inspect tab renders a single thinking value when not clamped", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.requestedThinkingLevel = "medium";
	state.activeWorkers.w1!.effectiveThinkingLevel = "medium";
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1" });

	const lines = renderPlain(component, 100);
	const thinkingLine = lines.find((line) => line.includes("Thinking:"));
	assert.ok(thinkingLine, "expected Thinking line in Inspect tab");
	assert.ok(thinkingLine.includes("Thinking: medium"), thinkingLine);
	assert.ok(!thinkingLine.includes("->"), thinkingLine);
	assert.ok(!thinkingLine.includes("(clamped)"), thinkingLine);
});

test("inspect tab renders requested -> effective thinking with warning color when clamped", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.requestedThinkingLevel = "high";
	state.activeWorkers.w1!.effectiveThinkingLevel = "medium";
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1" });

	const rawLines = component.render(100);
	const lines = plainLines(rawLines);
	const thinkingLine = lines.find((line) => line.includes("Thinking:"));
	assert.ok(thinkingLine, "expected Thinking line in Inspect tab");
	assert.ok(thinkingLine.includes("Thinking: high -> medium (clamped)"), thinkingLine);
	assert.ok(
		rawLines.some((line) => line.includes("\x1b[38;5;179mhigh -> medium (clamped)\x1b[0m")),
		"expected clamped thinking value to use warning color",
	);
});

test("workers tab shows clamped suffix without exceeding width or row budget", () => {
	const state = makeState(6);
	for (const worker of Object.values(state.activeWorkers)) {
		worker.requestedThinkingLevel = "high";
		worker.effectiveThinkingLevel = "low";
		worker.profileName = `reviewer-with-long-name-${worker.workerId}`;
	}

	const wide = makeComponent({ state, rows: 30, cols: 100 }).component;
	wide.handleInput("1");
	assert.ok(renderPlain(wide, 100).some((line) => line.includes("(clamped)")), "expected compact clamped suffix on worker rows");

	for (const termRows of [14, 30]) {
		for (const cols of [44, 60]) {
			const { component } = makeComponent({ state, rows: termRows, cols });
			component.handleInput("1");
			const lines = renderPlain(component, cols);
			assert.equal(lines.length, Math.floor(termRows * 0.9), `termRows=${termRows} cols=${cols}`);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= cols, `cols=${cols} got width ${visibleWidth(line)} for line: ${line}`);
			}
		}
	}
});

test("action bar dispatches steer/message/close/cancel/prune/refresh/copy through the manager", async () => {
	const state = makeState(1);
	state.activeWorkers.w1!.status = "running";
	const { component, calls } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1" });

	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[s]teer")));

	component.handleInput("s");
	for (const ch of "focus on transport") component.handleInput(ch);
	component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.messages.length, 1);
	assert.equal(calls.messages[0]!.delivery, "steer");
	assert.equal(calls.messages[0]!.message, "focus on transport");

	state.activeWorkers.w1!.status = "idle";
	component.handleInput("m");
	for (const ch of "next step") component.handleInput(ch);
	component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.messages.length, 2);
	assert.equal(calls.messages[1]!.delivery, "auto");

	component.handleInput("c");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.closes, ["w1"]);

	state.activeWorkers.w1!.status = "running";
	component.handleInput("x");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.cancels, ["w1"]);

	component.handleInput("p");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.prunes, 1);

	component.handleInput("r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.pings, 1);
});

test("[s]teer accepts idle/waiting workers (delivery resolver upgrades to prompt)", async () => {
	const state = makeState(1);
	state.activeWorkers.w1!.status = "idle";
	const { component, calls } = makeComponent({ state, rows: 28, cols: 100, initialWorkerId: "w1" });

	component.handleInput("s");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Steer w1:")), "expected steer modal to open on idle worker");
	for (const ch of "wake up") component.handleInput(ch);
	component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.messages.length, 1);
	assert.equal(calls.messages[0]!.delivery, "steer", "overlay forwards steer; resolver in messageWorker handles upgrade");
});

test("[s]teer rejects only truly unreachable terminal workers", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.status = "exited";
	const { component, calls } = makeComponent({ state, rows: 28, cols: 100, initialWorkerId: "w1" });
	component.handleInput("s");
	const lines = renderPlain(component, 100);
	assert.ok(!lines.some((line) => line.includes("Steer w1:")), "expected modal to refuse exited worker");
	assert.ok(lines.some((line) => line.includes("RPC disposed")), "expected status hint");
	assert.equal(calls.messages.length, 0);
});

test("[n]ew is refused while routingMode is solo", async () => {
	const state = makeState(1);
	state.activeWorkers.w1!.status = "idle";
	const { component, calls } = makeComponent({ state, rows: 28, cols: 100, initialWorkerId: "w1", routingMode: "solo" });
	component.handleInput("n");
	const lines = renderPlain(component, 100);
	assert.ok(!lines.some((line) => line.includes("New task (")), "modal must not open in solo");
	assert.ok(lines.some((line) => line.includes("Team routing off")), "expected solo guard tip");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.delegates.length, 0);
});

test("console auto-follow keeps the newest line visible", () => {
	const state = makeState(1);
	const chunks: AssistantChunk[] = Array.from({ length: 30 }, (_, i) => ({ index: i, ts: Date.now() + i, text: `line-${i}` }));
	const { component } = makeComponent({ state, rows: 22, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("line-29")), `expected last chunk in tail render; lines:\n${lines.join("\n")}`);
});

test("inline modal captures keystrokes and esc cancels", () => {
	const { component, calls } = makeComponent({ rows: 28, cols: 100, initialWorkerId: "w1" });
	component.handleInput("s");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Steer w1:")), "expected steer modal label");

	for (const ch of "abort") component.handleInput(ch);
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Steer w1: abort")));

	component.handleInput("\x1b");
	lines = renderPlain(component, 100);
	assert.ok(!lines.some((line) => line.includes("Steer w1:")));
	assert.equal(calls.messages.length, 0);
});

test("inline modal normalizes pasted multiline input to one rendered line", async () => {
	const { component, calls } = makeComponent({ rows: 28, cols: 100, initialWorkerId: "w1" });
	component.handleInput("s");
	component.handleInput("first line\nsecond line\r\nthird line");
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Steer w1: first line second line third line")));
	assert.ok(!lines.some((line) => line === "second line" || line === "third line"), "modal input must not create unframed rows");

	component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.messages[0]!.message, "first line second line third line");
});

test("new task modal calls delegateTask fresh (never reuses the selected worker)", async () => {
	const state = makeState(1);
	state.activeWorkers.w1!.profileName = "reviewer";
	state.activeWorkers.w1!.status = "idle";
	const { component, calls } = makeComponent({ state, rows: 28, cols: 100, initialWorkerId: "w1" });

	component.handleInput("n");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("New task (reviewer):")));
	for (const ch of "ship the doc") component.handleInput(ch);
	component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.delegates.length, 1);
	assert.equal(calls.delegates[0]!.profileName, "reviewer");
	assert.equal(calls.delegates[0]!.goal, "ship the doc");
	assert.equal(calls.delegates[0]!.reuseWorkerId, undefined, "expected fresh delegate, not silent reuse");
});

test("dispose unsubscribes the assistant-chunk listener (and is idempotent)", () => {
	const state = makeState(1);
	let subscribed = 0;
	let unsubscribed = 0;
	const tui = { terminal: { rows: 28, columns: 100 }, requestRender: () => {} };
	const manager = makeFakeManager({ state });
	(manager as unknown as { onAssistantChunk: () => () => void }).onAssistantChunk = () => {
		subscribed += 1;
		return () => {
			unsubscribed += 1;
		};
	};
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {});
	renderPlain(component, 100);
	assert.equal(subscribed, 1);
	assert.equal(unsubscribed, 0);
	component.dispose();
	assert.equal(unsubscribed, 1);
	component.dispose();
	assert.equal(unsubscribed, 1, "expected dispose to be idempotent");
	component.handleInput("q");
	assert.equal(unsubscribed, 1, "q after explicit dispose must not double-unsubscribe");
});

test("console tab streams ring-buffer chunks with auto-follow toggle", () => {
	const state = makeState(1);
	const chunks: AssistantChunk[] = Array.from({ length: 8 }, (_, i) => ({ index: i, ts: Date.now() + i * 10, text: `chunk ${i}` }));
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });

	component.handleInput("3");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("chunks=8")));
	assert.ok(lines.some((line) => line.includes("[follow]")));
	assert.ok(lines.some((line) => line.includes("chunk 7")));

	component.handleInput("\x1b[5~");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[paused")));

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[follow]")));

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[paused")), "f should toggle console follow off");

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[follow]")), "f should toggle console follow on");
});

test("inspect tab supports follow mode and mac-friendly scroll aliases", () => {
	const state = makeState(1);
	const transcript = Array.from({ length: 30 }, (_, i) => `assistant line ${i}`).join("\n");
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1", transcripts: { w1: transcript } });

	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[paused")), "Inspect should start in manual scroll mode");
	assert.ok(!lines.some((line) => line.includes("assistant line 29")), "tail should not be visible before jumping bottom");

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[follow]")), "G should jump bottom and follow");
	assert.ok(lines.some((line) => line.includes("assistant line 29")), "bottom should show latest assistant text");

	component.handleInput("b");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[paused")), "b should page up and pause follow");

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[follow]")), "f should toggle Inspect follow back on");
});

test("console isolates assistant text per worker", () => {
	const state = makeState(2);
	const { component } = makeComponent({
		state,
		rows: 30,
		cols: 100,
		initialWorkerId: "w1",
		chunks: {
			w1: [{ index: 0, ts: Date.now(), text: "alpha" }],
			w2: [{ index: 0, ts: Date.now(), text: "beta" }],
		},
	});
	component.handleInput("3");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("alpha")));
	assert.ok(!lines.some((line) => line.includes("beta")));

	component.handleInput("1");
	component.handleInput("j");
	component.handleInput("3");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("beta")));
	assert.ok(!lines.some((line) => line.includes("alpha")));
});

test("solo routing mode shows badge in tab bar", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, initialWorkerId: "w1", routingMode: "solo" });
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("solo")));
});

test("cost tab shows aggregate Σ and per-worker rows with compact tokens", () => {
	const state = makeState(2);
	state.activeWorkers.w1!.usage = { ...state.activeWorkers.w1!.usage, turns: 3, inputTokens: 123_456, outputTokens: 50_000, costUsd: 0.25 };
	state.activeWorkers.w2!.usage = { ...state.activeWorkers.w2!.usage, turns: 1, inputTokens: 20_000, outputTokens: 1_250_000, costUsd: 0.05 };
	const { component } = makeComponent({ state, rows: 28, cols: 100 });
	component.handleInput("4");
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Σ")));
	assert.ok(lines.some((line) => line.includes("in=143.5k") && line.includes("out=1.3m")), "expected compact aggregate token counts");
	assert.ok(lines.some((line) => line.includes("$0.3000")), "cost precision should remain monetary");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("reviewer") && line.includes("in=123.5k") && line.includes("out=50k")));
});

test("cost tab includes retained pruned usage in aggregate and note", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.usage = { ...state.activeWorkers.w1!.usage, turns: 3, inputTokens: 100_000, outputTokens: 50_000, costUsd: 0.25 };
	state.prunedWorkerUsageTotals = {
		workers: 2,
		turns: 4,
		inputTokens: 20_000,
		outputTokens: 1_250_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.05,
		contextTokens: 0,
	};
	const { component } = makeComponent({ state, rows: 28, cols: 100 });
	component.handleInput("4");
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Σ workers=3") && line.includes("in=120k") && line.includes("out=1.3m")), "expected active plus retained aggregate totals");
	assert.ok(lines.some((line) => line.includes("retained/pruned: workers=2") && line.includes("in=20k")), "expected retained/pruned note");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("in=100k")), "expected active per-worker row to remain visible");
});

test("cost tab shows retained-only aggregate after all workers are pruned", () => {
	const state = makeState(0);
	state.prunedWorkerUsageTotals = {
		workers: 2,
		turns: 4,
		inputTokens: 20_000,
		outputTokens: 1_250_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.05,
		contextTokens: 0,
	};
	const { component } = makeComponent({ state, rows: 28, cols: 100 });
	component.handleInput("4");
	const lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("Σ workers=2") && line.includes("out=1.3m")), "expected retained-only aggregate totals");
	assert.ok(lines.some((line) => line.includes("retained/pruned: workers=2")), "expected retained/pruned note");
	assert.ok(!lines.some((line) => /\bw\d+\b/.test(line)), "expected no per-worker rows");
});

test("inspect tab usage line uses compact tokens and context budget", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.usage = {
		...state.activeWorkers.w1!.usage,
		turns: 7,
		inputTokens: 1_250_000,
		outputTokens: 12_345,
		costUsd: 1.2345,
		contextTokens: 128_000,
		contextWindow: 200_000,
		contextPercent: 64,
		contextRemainingTokens: 72_000,
	};
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1" });
	const lines = renderPlain(component, 100);
	const usageLine = lines.find((line) => line.includes("turns=7"));
	assert.ok(usageLine, "expected usage line in Inspect tab");
	assert.ok(usageLine.includes("in=1.3m"), usageLine);
	assert.ok(usageLine.includes("out=12.3k"), usageLine);
	assert.ok(usageLine.includes("cost=$1.2345"), usageLine);
	assert.ok(usageLine.includes("ctx=64%/200k rem=72k"), usageLine);
});

test("cost tab compact large token counts do not exceed terminal width", () => {
	const state = makeState(3);
	state.activeWorkers.w1!.usage = { ...state.activeWorkers.w1!.usage, turns: 99_999, inputTokens: 987_654_321, outputTokens: 123_456_789, costUsd: 1234.5678 };
	state.activeWorkers.w2!.usage = { ...state.activeWorkers.w2!.usage, turns: 88_888, inputTokens: 876_543_210, outputTokens: 9_876_543, costUsd: 987.6543 };
	state.activeWorkers.w3!.usage = { ...state.activeWorkers.w3!.usage, turns: 77_777, inputTokens: 765_432_109, outputTokens: 8_765_432, costUsd: 876.5432 };
	const wide = makeComponent({ state, rows: 32, cols: 120 });
	wide.component.handleInput("4");
	assert.ok(renderPlain(wide.component, 120).some((line) => line.includes("in=987.7m")), "expected compact million-scale Cost tab tokens");

	for (const cols of [44, 52, 60]) {
		const { component } = makeComponent({ state, rows: 32, cols });
		component.handleInput("4");
		const lines = renderPlain(component, cols);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= cols, `cols=${cols} got width ${visibleWidth(line)} for line: ${line}`);
		}
	}
});

test("tabs and control chars in worker content do not bust panel width", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.lastSummary!.headline = "first\tsecond\tthird\t" + "x".repeat(120);
	state.activeWorkers.w1!.currentTask!.goal = "line one\n\t\t\t// indented diff line that would overrun visibleWidth\n+\t\t\treturn null;";
	const transcripts = {
		w1: "tab\tseparated\tassistant\ttext\nplus\x1b[31mansi-looking\x1b[0m and\bbackspace and \x07bell",
	};
	const chunks: AssistantChunk[] = [
		{ index: 0, ts: Date.now(), text: "+\t\t\t// surprise tab line worth 32 cols when rendered" },
	];
	const widths = [80, 100, 116, 140];
	for (const cols of widths) {
		const { component } = makeComponent({ state, rows: 28, cols, initialWorkerId: "w1", transcripts, chunks: { w1: chunks } });
		for (const tabKey of ["1", "2", "3"]) {
			component.handleInput(tabKey);
			const lines = renderPlain(component, cols);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= cols, `tab ${tabKey} cols=${cols} got width ${visibleWidth(line)} for line: ${JSON.stringify(line)}`);
				assert.ok(!line.includes("\t"), `tab ${tabKey} cols=${cols} line still contains \\t: ${JSON.stringify(line)}`);
			}
		}
	}
});

test("render output is capped at min(width, terminal.columns) so an oversized panel cannot overflow the terminal", () => {
	const state = makeState(2);
	const tui = { terminal: { rows: 30, columns: 60 }, requestRender: () => {} };
	const manager = makeFakeManager({ state });
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {});
	component.handleInput("2");
	const lines = renderPlain(component, 120);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 60, `expected cap at terminal 60, got ${visibleWidth(line)}: ${line}`);
	}
});

test("visibleWidth is enforced across all tabs and worst-case content", () => {
	const state = makeState(4);
	state.activeWorkers.w1!.lastSummary!.headline = "x".repeat(300);
	state.activeWorkers.w1!.currentTask!.title = "🚀".repeat(80);
	const widths = [60, 80, 100, 140];
	for (const cols of widths) {
		const { component } = makeComponent({ state, rows: 30, cols });
		for (const tabKey of ["1", "2", "3", "4"]) {
			component.handleInput(tabKey);
			const lines = renderPlain(component, cols);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= cols, `tab ${tabKey} cols=${cols} line ${visibleWidth(line)}: ${line}`);
			}
		}
	}
});

test("render row count matches overlay maxHeight so the bottom frame is never clipped", () => {
	const state = makeState(1);
	for (const termRows of [14, 15, 30, 40, 60, 80]) {
		const { component } = makeComponent({ state, rows: termRows, cols: 100, initialWorkerId: "w1" });
		const lines = renderPlain(component, 100);
		const expected = Math.floor(termRows * 0.9);
		assert.equal(
			lines.length,
			expected,
			`termRows=${termRows} got ${lines.length} rows, expected ${expected} (must match maxHeight 90%)`,
		);
		assert.ok(lines[0].startsWith("╭"), `top frame missing for termRows=${termRows}`);
		assert.ok(lines[lines.length - 1].startsWith("╰"), `bottom frame missing for termRows=${termRows}`);
	}
});

test("framed panel renders top/bottom borders and side bars at any width", () => {
	const state = makeState(4);
	const { component } = makeComponent({ state, rows: 32, cols: 60, initialWorkerId: "w1" });
	component.handleInput("2");
	const lines = renderPlain(component, 60);
	assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"), `expected top frame, got: ${lines[0]}`);
	assert.ok(lines[lines.length - 1].startsWith("╰") && lines[lines.length - 1].endsWith("╯"), `expected bottom frame, got: ${lines[lines.length - 1]}`);
	assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")), "every body row must have side bars");
	assert.ok(lines.some((line) => line.includes("Pi Agents Team")), "title in top frame");
	assert.ok(lines.some((line) => line.includes("Final answer") || line.includes("Latest assistant text")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 60, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
});

test("q quits the overlay", () => {
	const state = makeState(1);
	const tui = { terminal: { rows: 28, columns: 100 }, requestRender: () => {} };
	const manager = makeFakeManager({ state });
	let closed = 0;
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {
		closed += 1;
	});
	renderPlain(component, 100);
	component.handleInput("q");
	assert.equal(closed, 1);
});

test("overlay tab list shows 4 tabs when displayCost is true", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, displayCost: true });
	const lines = renderPlain(component, 100);
	const tabLine = lines.find((line) => line.includes("Workers") && line.includes("Inspect") && line.includes("Console"));
	assert.ok(tabLine, "expected tab bar line");
	assert.ok(tabLine!.includes("Cost"), "expected Cost tab when displayCost=true");
});

test("overlay tab list shows 3 tabs (no Cost) when displayCost is false", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, displayCost: false });
	const lines = renderPlain(component, 100);
	const tabLine = lines.find((line) => line.includes("Workers") && line.includes("Inspect") && line.includes("Console"));
	assert.ok(tabLine, "expected tab bar line");
	assert.ok(!tabLine!.includes("Cost"), "expected Cost tab absent when displayCost=false");
});

test("key 4 is ignored when displayCost is false", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, displayCost: false });
	component.handleInput("1");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[1 Workers]")), "should be on workers tab");

	component.handleInput("4");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[1 Workers]")), "key 4 must be a no-op when Cost tab is hidden");
});

test("tab cycle wraps through only 3 tabs when displayCost is false", () => {
	const { component } = makeComponent({ rows: 28, cols: 100, displayCost: false });
	component.handleInput("1");
	component.handleInput("\t");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[2 Inspect]")));

	component.handleInput("\t");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[3 Console]")));

	component.handleInput("\t");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("[1 Workers]")), "cycle should wrap back to Workers, skipping Cost");
});

test("render row count matches overlay maxHeight when displayCost is false", () => {
	const state = makeState(1);
	for (const termRows of [14, 15, 30, 40]) {
		const { component } = makeComponent({ state, rows: termRows, cols: 100, displayCost: false });
		const lines = renderPlain(component, 100);
		const expected = Math.floor(termRows * 0.9);
		assert.equal(
			lines.length,
			expected,
			`termRows=${termRows} got ${lines.length} rows, expected ${expected} (must match maxHeight 90%)`,
		);
	}
});
