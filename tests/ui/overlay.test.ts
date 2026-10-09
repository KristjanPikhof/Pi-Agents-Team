import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createDefaultTeamState } from "../../src/config";
import type { TeamManager } from "../../src/control-plane/team-manager";
import {
	buildTabBar,
	createTeamDashboardOverlayComponent,
	openTeamDashboardOverlay,
	sanitizeText,
	TEAM_DASHBOARD_INITIAL_REFRESH_TIMEOUT_MS,
	TEAM_DASHBOARD_OVERLAY_OPTIONS,
} from "../../src/ui/overlay";
import { sanitizeTerminalText, stripAnsi, themedPalette } from "../../src/ui/theme";
import {
	CONSOLE_ACTIVITY_GOLDEN_LINES,
	CONSOLE_RAW_FALLBACK_GOLDEN_LINES,
	INSPECT_RECENT_ACTIVITY_GOLDEN_LINES,
	NARROW_CONSOLE_ACTIVITY_GOLDEN_LINES,
	NARROW_CONSOLE_ACTIVITY_WIDTH,
} from "./activity-log-examples";

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

function assertRenderedSubsequence(renderedLines: string[], expectedLines: readonly string[], label: string): void {
	let cursor = 0;
	for (const expected of expectedLines) {
		if (expected === "") continue;
		const index = renderedLines.findIndex((line, lineIndex) => lineIndex >= cursor && line.includes(expected));
		assert.ok(index >= 0, `expected ${label} line ${JSON.stringify(expected)} after index ${cursor}; got:\n${renderedLines.join("\n")}`);
		cursor = index + 1;
	}
}

function makeFakeTheme(): Theme {
	const roleCodes: Record<string, string> = {
		accent: "38;5;201",
		dim: "38;5;244",
		muted: "38;5;245",
		syntaxKeyword: "38;5;81",
		syntaxType: "38;5;141",
		success: "38;5;120",
		warning: "38;5;214",
		error: "38;5;196",
	};
	return {
		fg: (role: string, text: string) => `\x1b[${roleCodes[role] ?? "39"}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[0m`,
		bg: (_role: string, text: string) => `\x1b[48;5;237m${text}\x1b[49m`,
	} as unknown as Theme;
}
import type { AssistantChunk, WorkerActivityEvent, WorkerConsoleEvent } from "../../src/runtime/worker-manager";
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
	activities?: Record<string, WorkerActivityEvent[]>;
	chunks?: Record<string, AssistantChunk[]>;
	activityListeners?: Array<(workerId: string, event: WorkerActivityEvent) => void>;
	routingMode?: "team" | "solo";
	displayCost?: boolean;
	profiles?: string[];
	calls?: FakeManagerCalls;
	pingWorkers?: () => Promise<unknown>;
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
			return options.pingWorkers?.();
		},
		getWorkerTranscript: (workerId: string) => options.transcripts?.[workerId],
		getWorkerConsole: (workerId: string) => options.consoles?.[workerId] ?? [],
		getWorkerActivity: (workerId: string) => options.activities?.[workerId] ?? [],
		getAssistantTail: (workerId: string) => options.chunks?.[workerId] ?? [],
		onAssistantChunk: () => () => {},
		onActivityEvent: (listener: (workerId: string, event: WorkerActivityEvent) => void) => {
			(options.activityListeners ??= []).push(listener);
			return () => {
				const index = options.activityListeners?.indexOf(listener) ?? -1;
				if (index >= 0) options.activityListeners?.splice(index, 1);
			};
		},
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
	activities?: Record<string, WorkerActivityEvent[]>;
	chunks?: Record<string, AssistantChunk[]>;
	routingMode?: "team" | "solo";
	displayCost?: boolean;
	theme?: Theme;
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
		activities: opts.activities,
		chunks: opts.chunks,
		routingMode: opts.routingMode,
		displayCost: opts.displayCost,
	};
	const manager = makeFakeManager(managerOpts);
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {}, {
		initialWorkerId: opts.initialWorkerId,
		theme: opts.theme,
	});
	return { component, state, tui, manager, calls: managerOpts.calls! };
}

test("openTeamDashboardOverlay uses the widened responsive overlay options", async () => {
	const state = makeState();
	const manager = makeFakeManager({ state });
	let capturedOptions: unknown;
	const fakeTheme = makeFakeTheme();
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			custom: async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
				capturedOptions = customOptions;
				factory({ terminal: { rows: 30, columns: 120 }, requestRender: () => {} }, fakeTheme, {}, () => {});
			},
		},
	} as any;

	await openTeamDashboardOverlay(ctx, manager);
	assert.deepEqual((capturedOptions as { overlayOptions: unknown }).overlayOptions, TEAM_DASHBOARD_OVERLAY_OPTIONS);
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.width, "50%");
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight, "90%");
	assert.equal(TEAM_DASHBOARD_OVERLAY_OPTIONS.anchor, "top-right");
	assert.equal(TEAM_DASHBOARD_INITIAL_REFRESH_TIMEOUT_MS, 5_000);
});

test("openTeamDashboardOverlay falls back from the loading spinner when active ping hangs", async () => {
	const state = makeState();
	const manager = makeFakeManager({ state, pingWorkers: () => new Promise(() => {}) });
	let component: OverlayComponent | undefined;
	let renders = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			custom: async (factory: (...args: unknown[]) => unknown) => {
				component = factory({ terminal: { rows: 30, columns: 120 }, requestRender: () => { renders += 1; } }, makeFakeTheme(), {}, () => {}) as OverlayComponent;
			},
		},
	} as any;

	await openTeamDashboardOverlay(ctx, manager, { initialRefreshTimeoutMs: 1 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(component, "expected overlay component");
	const lines = renderPlain(component!, 100);
	assert.ok(lines.some((line) => line.includes("Pi Agents Team · /team")), `expected dashboard after ping timeout; got:\n${lines.join("\n")}`);
	assert.ok(!lines.some((line) => line.includes("Loading team dashboard")), `expected loading spinner to be replaced; got:\n${lines.join("\n")}`);
	assert.equal((manager as unknown as { snapshot(): PersistedTeamState }).snapshot(), state);
	assert.ok(renders > 0, "expected fallback to request a render");
	component!.dispose?.();
});

test("openTeamDashboardOverlay tolerates a partial theme while showing the loader", async () => {
	const state = makeState();
	const manager = makeFakeManager({ state });
	let component: OverlayComponent | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			custom: async (factory: (...args: unknown[]) => unknown) => {
				component = factory({ terminal: { rows: 30, columns: 120 }, requestRender: () => {} }, {}, {}, () => {}) as OverlayComponent;
			},
		},
	} as any;

	await openTeamDashboardOverlay(ctx, manager, { initialRefreshTimeoutMs: 1 });
	await new Promise((resolve) => setImmediate(resolve));

	assert.ok(component, "expected overlay component");
	const lines = renderPlain(component!, 100);
	assert.ok(lines.some((line) => line.includes("Pi Agents Team · /team")), `expected dashboard after partial-theme loader; got:\n${lines.join("\n")}`);
	component!.dispose?.();
});

test("overlay rendering uses the supplied Theme palette roles", () => {
	const { component } = makeComponent({ theme: makeFakeTheme(), rows: 30, cols: 120 });
	const lines = component.render(120);
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;201m")), `expected themed accent role; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;244m")), `expected themed dim role; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("\x1b[1m")), `expected themed bold role; got:\n${lines.join("\n")}`);
	assert.ok(!lines.some((line) => line.includes("\x1b[38;5;75m")), "expected no legacy accent fallback when a full Theme is supplied");
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
	assert.ok(lines.some((line) => line.includes("Working")));
	assert.ok(lines.some((line) => line.includes("Done")));

	component.handleInput("j");
	component.handleInput("j");
	lines = renderPlain(component, 100);
	const selectedRow = lines.find((line) => line.includes("> w"));
	assert.ok(selectedRow, "expected selection arrow on a row");
});

test("workers tab keeps the selected worker visible on short overlays", () => {
	const state = makeState(35);
	const { component } = makeComponent({ state, rows: 20, cols: 100, initialWorkerId: "w30" });

	component.handleInput("1");
	const lines = renderPlain(component, 100);
	const selectedRow = lines.find((line) => line.includes("> w"));
	assert.ok(selectedRow, `expected selected row to be visible; got:\n${lines.join("\n")}`);
	assert.match(selectedRow, /w30/);
});

test("workers tab shows compact summary, selected mini header, and state-specific action hint", () => {
	const state = makeState(4);
	state.activeWorkers.w1!.pendingRelayQuestions = [{
		relayId: "relay-1",
		workerId: "w1",
		taskId: "t1",
		question: "Need deployment approval?",
		assumption: "wait",
		urgency: "high",
		createdAt: Date.now(),
	}];
	state.activeWorkers.w2!.status = "error";
	state.activeWorkers.w2!.error = "RPC crashed";
	state.activeWorkers.w3!.status = "idle";
	state.activeWorkers.w3!.finalAnswer = "headline: done";
	const { component } = makeComponent({ state, rows: 34, cols: 96, initialWorkerId: "w1" });

	component.handleInput("1");
	const lines = renderPlain(component, 96);
	const body = lines.join("\n");
	assert.match(body, /4 workers .*1 needs reply .*1 needs recovery .*1 working .*1 done/);
	assert.match(body, /w1 · reviewer · Running · Answer relay/);
	assert.match(body, /Needs reply \(1\)/);
	assert.match(body, /Needs recovery \(1\)/);
	assert.match(body, /Done \(1\)/);
	assert.equal(lines.length, Math.floor(34 * 0.9));
	for (const line of lines) assert.ok(visibleWidth(line) <= 96, `line exceeds width: ${visibleWidth(line)} ${line}`);
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

test("inspect tab renders structured readable sections with styled headers", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.pendingRelayQuestions = [{
		id: "rq1",
		question: "Can I proceed with migration?",
		assumption: "Use the existing default.",
		urgency: "normal",
		createdAt: Date.now(),
	}];
	state.activeWorkers.w1!.finalAnswer = "headline: fixed\nchanged_files:\n- src/ui/overlay.ts";
	const { component } = makeComponent({
		state,
		rows: 48,
		cols: 100,
		initialWorkerId: "w1",
		transcripts: { w1: "latest assistant detail" },
	});

	const rawLines = component.render(100);
	const lines = plainLines(rawLines);
	const body = lines.join("\n");
	for (const section of ["Status", "Task", "Needs operator", "Summary", "Final answer", "Latest assistant text"]) {
		assert.ok(body.includes(section), `expected Inspect section ${section}`);
	}
	assert.ok(lines.some((line) => line.includes("Status [running]")), "expected plain Status section");
	assert.ok(lines.some((line) => line.includes("Final answer [ok]")), "expected plain Final answer section");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;75mStatus\x1b[0m")), "expected styled Status header");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;179mrunning\x1b[0m")), "expected a worker needing a reply to use warning color");
	assert.ok(rawLines.some((line) => line.includes("\x1b[38;5;244mThinking:\x1b[0m")), "expected dimmed metadata label");
});

test("inspect tab marks oversized assistant transcript as truncated", () => {
	const state = makeState(1);
	const transcript = `${"older line\n".repeat(40_000)}tail line`;
	const { component } = makeComponent({
		state,
		rows: 10_000,
		cols: 100,
		initialWorkerId: "w1",
		transcripts: { w1: transcript },
	});

	component.handleInput("\r");
	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Latest assistant text \[tail\]/);
	assert.match(body, /\[transcript truncated: showing retained tail; omitted /);
	assert.match(body, /tail line/);
	assert.ok((body.match(/older line/g)?.length ?? 0) < 40_000, "inspect output should not include the full oversized transcript");
});

test("inspect tab visually separates final answer from latest assistant text and remains width-safe", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = `Final answer ${"alpha beta ".repeat(18)}`;
	const { component } = makeComponent({
		state,
		rows: 80,
		cols: 58,
		initialWorkerId: "w1",
		transcripts: { w1: `Latest assistant ${"gamma delta ".repeat(18)}` },
	});

	component.handleInput("\r");
	const lines = renderPlain(component, 58);
	const finalIndex = lines.findIndex((line) => line.includes("Final answer [ok]"));
	const latestIndex = lines.findIndex((line) => line.includes("Latest assistant text [tail]"));
	assert.ok(finalIndex >= 0, "expected Final answer block header");
	assert.ok(latestIndex > finalIndex, "expected Latest assistant text after Final answer");
	assert.ok(lines.slice(finalIndex + 1, latestIndex).some((line) => line.includes("Final answer alpha")), "expected final answer content under its header");
	assert.ok(lines.slice(latestIndex + 1).some((line) => line.includes("Latest assistant gamma")), "expected latest assistant text content under its header");
	assert.ok(lines[finalIndex]!.includes("Final answer [ok]"), lines[finalIndex]);
	assert.ok(lines[latestIndex]!.includes("Latest assistant text [tail]"), lines[latestIndex]);
	for (const line of lines) assert.ok(visibleWidth(line) <= 58, `line exceeds width: ${visibleWidth(line)} ${line}`);
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

test("overlay copy hotkey requests real worker activity events for the payload", async () => {
	const state = makeState(1);
	let activityCalls = 0;
	const manager = makeFakeManager({ state });
	(manager as unknown as { getWorkerActivity(workerId: string): WorkerActivityEvent[] }).getWorkerActivity = (workerId: string) => {
		activityCalls += 1;
		return [{
			id: "activity-1",
			ts: Date.now(),
			updatedAt: Date.now(),
			actionKind: "command",
			status: "completed",
			label: "Ran npm test",
			summary: "npm test",
			command: "npm test",
			sourceEvent: "worker_tool_finished",
		}];
	};
	const originalPath = process.env.PATH;
	process.env.PATH = "";
	try {
		const component = createTeamDashboardOverlayComponent(
			{ terminal: { rows: 30, columns: 100 }, requestRender: () => {} },
			manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1],
			state,
			() => {},
			{ initialWorkerId: "w1" },
		);
		component.handleInput("y");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(activityCalls, 1);
	} finally {
		process.env.PATH = originalPath;
	}
});

test("inspect live-follow re-renders on activity-only updates", () => {
	const state = makeState(1);
	const managerOpts: FakeManagerOptions = { state, activityListeners: [] };
	let renders = 0;
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => { renders += 1; } };
	const manager = makeFakeManager(managerOpts);
	const component = createTeamDashboardOverlayComponent(tui, manager as unknown as Parameters<typeof createTeamDashboardOverlayComponent>[1], state, () => {}, {
		initialWorkerId: "w1",
	});
	component.handleInput("f");
	renders = 0;
	managerOpts.activityListeners![0]!("w1", {
		id: "activity-1",
		ts: Date.now(),
		updatedAt: Date.now(),
		actionKind: "tool",
		status: "completed",
		label: "Used read",
		sourceEvent: "worker_tool_finished",
	});
	assert.equal(renders, 1);
	component.dispose();
});

test("paused Console updates the selected tool without following new rows", () => {
	const event: WorkerActivityEvent = { id: "read-1", ts: 1, updatedAt: 1, actionKind: "tool", status: "started", toolName: "read", label: "Used read", summary: "selected.ts", sourceEvent: "worker_tool_started" };
	const managerOpts: FakeManagerOptions = { state: makeState(1), activities: { w1: [event] }, activityListeners: [] };
	let renders = 0;
	const component = createTeamDashboardOverlayComponent(
		{ terminal: { rows: 30, columns: 100 }, requestRender: () => { renders += 1; } },
		makeFakeManager(managerOpts), managerOpts.state, () => {},
	);
	component.handleInput("3");
	component.render(100);
	component.handleInput("f");
	managerOpts.activities!.w1!.push({ ...event, id: "read-2", summary: "new.ts" });
	event.status = "completed";
	event.outputSnippet = "Selected file finished";
	renders = 0;
	managerOpts.activityListeners![0]!("w1", event);
	assert.equal(renders, 1);
	const plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /> read\s+selected.ts\s+\[ok\]/);
	assert.match(plain, /Selected file finished/);
	assert.match(plain, /Activity · \[paused\]/);
	component.dispose();
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

test("inspect formatter preserves Markdown-like headings and tables", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = [
		"# Findings",
		"",
		"| Area | Status |",
		"| --- | --- |",
		"| formatter | passing |",
		"",
		"- list item with enough text to exercise continuation indentation in the report body",
	].join("\n");
	const { component } = makeComponent({ state, rows: 44, cols: 90, initialWorkerId: "w1" });

	const rawLines = component.render(90);
	const lines = plainLines(rawLines);
	assert.ok(lines.some((line) => line.includes("# Findings")), "expected heading text to be preserved");
	assert.ok(lines.some((line) => line.includes("| Area | Status |")), "expected table row to be preserved");
	assert.ok(lines.some((line) => line.includes("| --- | --- |")), "expected table separator to be preserved");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;75m# Findings\x1b[0m")), "expected heading styling");
	for (const line of lines) assert.ok(visibleWidth(line) <= 90, `line exceeds width: ${visibleWidth(line)} ${line}`);
});

test("console formatter wraps long indented lines without ellipsis or overflow", () => {
	const state = makeState(1);
	const longIndented = `        const result = ${"veryLongIdentifier".repeat(8)};`;
	const chunks: AssistantChunk[] = [{ index: 0, ts: Date.now(), text: longIndented }];
	const { component } = makeComponent({ state, rows: 30, cols: 58, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	const lines = renderPlain(component, 58);
	const wrapped = lines.filter((line) => line.startsWith("│     ") && (line.includes("veryLongIdentifier") || line.includes("const result")));
	assert.ok(wrapped.length >= 2, `expected long indented line to wrap, got:\n${lines.join("\n")}`);
	assert.ok(wrapped.some((line) => line.includes("const result")), "expected wrapped command/process text to remain visible");
	assert.ok(!wrapped.some((line) => line.includes("…")), "wrapping should not use truncation ellipsis");
	for (const line of lines) assert.ok(visibleWidth(line) <= 58, `line exceeds width: ${visibleWidth(line)} ${line}`);
});

test("formatter keeps mixed structured inspect output width-safe at narrow sizes", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = [
		"## Narrow report",
		"| Column | Long value |",
		"| --- | --- |",
		`| plain | ${"alpha beta ".repeat(12)} |`,
		"---",
		"Error: top level failure with a long stack-trace-like message that should continue safely",
		`    at Object.example (/tmp/${"nested/".repeat(10)}file.ts:12:34)`,
		`Plain paragraph ${"with many words ".repeat(14)}ending here.`,
	].join("\n");
	const { component } = makeComponent({ state, rows: 64, cols: 50, initialWorkerId: "w1" });

	const lines = renderPlain(component, 50);
	assert.ok(lines.some((line) => line.includes("## Narrow report")), "expected heading in narrow render");
	assert.ok(lines.some((line) => line.includes("↳") || line.includes("    at")), "expected continuation prefix or preserved stack indentation");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 50, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
});

test("console separates assistant text and events with readable assistant formatting", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [{ index: 0, ts: now, text: "# Console Heading\nassistant paragraph" }];
	const events: WorkerConsoleEvent[] = [{ ts: now + 1_000, kind: "tool_start", text: "read src/ui/overlay.ts" }];
	const { component } = makeComponent({ state, rows: 44, cols: 90, initialWorkerId: "w1", chunks: { w1: chunks }, consoles: { w1: events } });
	component.handleInput("3");
	component.handleInput("r");

	const rawLines = component.render(90);
	const lines = plainLines(rawLines);
	const assistantDividerIndex = lines.findIndex((line) => line.includes("— assistant —"));
	const eventsDividerIndex = lines.findIndex((line) => line.includes("— events —"));
	assert.ok(assistantDividerIndex >= 0, "expected assistant divider");
	assert.ok(eventsDividerIndex > assistantDividerIndex, "expected events divider after assistant group");
	assert.ok(lines.some((line) => line.includes("# Console Heading")), "expected assistant heading text");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;75m# Console Heading\x1b[0m")), "expected readable heading styling in assistant content");
	assert.ok(lines.some((line) => line.includes("[tool_start]") && line.includes("read src/ui/overlay.ts")), "expected event row");
});

test("console dims routine event metadata and highlights errors or recovery", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const events: WorkerConsoleEvent[] = [
		{ ts: now, kind: "status", text: "running" },
		{ ts: now + 1_000, kind: "error", text: "boom" },
		{ ts: now + 2_000, kind: "queue", text: "recovery prompt queued" },
	];
	const { component } = makeComponent({ state, rows: 44, cols: 90, initialWorkerId: "w1", consoles: { w1: events } });
	component.handleInput("3");
	component.handleInput("r");

	const rawLines = component.render(90);
	const lines = plainLines(rawLines);
	assert.ok(lines.some((line) => line.includes("[status] running")), "expected routine status row");
	assert.ok(lines.some((line) => line.includes("[error] boom")), "expected error row");
	assert.ok(lines.some((line) => line.includes("[queue] recovery prompt queued")), "expected recovery row");
	assert.ok(rawLines.some((line) => /\x1b\[2m\[\d{2}:\d{2}:\d{2}\]\x1b\[0m/.test(line) && line.includes("\x1b[2m[status]\x1b[0m")), "expected dimmed timestamp and routine kind metadata");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;167m[error]\x1b[0m") && line.includes("\x1b[38;5;167mboom\x1b[0m")), "expected error styling");
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;179m[queue]\x1b[0m") && line.includes("\x1b[38;5;179mrecovery prompt queued\x1b[0m")), "expected recovery styling");
});

test("console keeps assistant and event rows width-safe", () => {
	const state = makeState(1);
	const chunks: AssistantChunk[] = [{ index: 0, ts: Date.now(), text: `## ${"long assistant content ".repeat(12)}` }];
	const events: WorkerConsoleEvent[] = [{ ts: Date.now(), kind: "tool_end", text: "metadata ".repeat(30) }];
	const { component } = makeComponent({ state, rows: 34, cols: 52, initialWorkerId: "w1", chunks: { w1: chunks }, consoles: { w1: events } });
	component.handleInput("3");
	component.handleInput("r");

	const lines = renderPlain(component, 52);
	assert.ok(lines.some((line) => line.includes("— raw —")), "expected raw diagnostics marker at narrow width");
	assert.ok(lines.some((line) => line.includes("assistant") || line.includes("tool_end") || line.includes("metadata")), "expected diagnostic content at narrow width");
	for (const line of lines) assert.ok(visibleWidth(line) <= 52, `line exceeds width: ${visibleWidth(line)} ${line}`);
});

function makeActivityContractInputs(now = 1_700_000_000_000): { chunks: AssistantChunk[]; events: WorkerConsoleEvent[] } {
	return {
		chunks: [
			{ index: 0, ts: now, text: "Mapping current console rendering before proposing UI changes." },
			{
				index: 1,
				ts: now + 4_000,
				text: [
					"<final_answer>",
					"headline: APPROVE — no blocking issues found.",
					"risks:",
					"- UI wrapping tests need updates.",
					"next_recommendation: Safe to continue after typecheck.",
					"confidence: definite",
					"</final_answer>",
				].join("\n"),
			},
		],
		events: [
			{ ts: now + 1_000, kind: "tool_start", text: "git diff --stat main...HEAD" },
			{ ts: now + 2_000, kind: "tool_end", text: "src/ui/overlay.ts              | 42 +++++++++++++++++\ntests/ui/overlay.test.ts       | 18 +++++++\n… +14 lines hidden" },
		],
	};
}

test("console Activity fallback coalesces adjacent assistant chunks while Raw keeps each chunk", () => {
	const state = makeState(1);
	const chunks: AssistantChunk[] = Array.from({ length: 8 }, (_, index) => ({
		index,
		ts: 1_700_000_000_000 + index,
		text: index === 7 ? "done" : `token-${index} `,
	}));
	const { component } = makeComponent({ state, rows: 80, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	let lines = renderPlain(component, 100);
	let body = lines.join("\n");
	assert.equal((body.match(/> (?:Thinking|Final answer)/g) ?? []).length, 1, body);
	assert.equal((body.match(/> Thinking/g)?.length ?? 0), 1, body);
	assert.match(body, /token-0 token-1 token-2/);
	assert.match(body, /done/);

	component.handleInput("r");
	lines = renderPlain(component, 100);
	body = lines.join("\n");
	assert.match(body, /\[raw\] assistant chunk #0/);
	assert.match(body, /\[raw\] assistant chunk #7/);
});

test("console Activity contract renders final-answer fields through the shared parser", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [{
		index: 0,
		ts: now,
		text: [
			"<final_answer>",
			"headline: shared overlay headline",
			"risks:",
			"- overlay drift risk",
			"next_recommendation: keep parser shared",
			"</final_answer>",
		].join("\n"),
	}];
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Headline: shared overlay headline/);
	assert.match(body, /Risks: overlay drift risk/);
	assert.match(body, /Next: keep parser shared/);
});

test("console Activity fallback parses final-answer blocks split across assistant chunks", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [
		{ index: 0, ts: now, text: "Mapping result before final.\n<final_answer>\nhead" },
		{ index: 1, ts: now + 1_000, text: "line: split overlay headline\nrisks:\n- split tag risk\nnext_recommendation: keep fallback parser\n" },
		{ index: 2, ts: now + 2_000, text: "</final_answer>\nPostscript after final." },
	];
	const { component } = makeComponent({ state, rows: 60, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");
	renderPlain(component, 100);
	component.handleInput("k");

	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Thinking.*\[info\]/, "expected preamble/trailing activity to remain process thinking");
	assert.match(body, /Mapping result before final\./, "expected preamble process text");
	assert.match(body, /Postscript after final\./, "expected trailing process text");
	assert.match(body, /Final answer.*\[ok\]/, "expected split final-answer block as final summary");
	assert.match(body, /Headline: split overlay headline/);
	assert.match(body, /Risks: split tag risk/);
	assert.match(body, /Next: keep fallback parser/);
	assert.doesNotMatch(body, /Thinking[^\n]*headline: split overlay headline/, "final-answer body must not be rendered as process thinking");

	component.handleInput("r");
	const rawBody = renderPlain(component, 100).join("\n");
	assert.match(rawBody, /\[raw\] assistant chunk #0/);
	assert.match(rawBody, /<final_answer>/, "Raw diagnostics must retain original final-answer tag text");
	assert.match(rawBody, /<\/final_answer>/, "Raw diagnostics must retain original closing tag text");
});

test("console Activity fallback parses final-answer opening marker split across chunks", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [
		{ index: 0, ts: now, text: "Preamble before split marker.\n<fi" },
		{ index: 1, ts: now + 1_000, text: "nal_" },
		{ index: 2, ts: now + 2_000, text: "answer>\nheadline: split-open headline\nrisks:\n- open marker risk\n</final_answer>" },
	];
	const { component } = makeComponent({ state, rows: 70, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Final answer.*\[ok\]/);
	assert.match(body, /Headline: split-open headline/);
	assert.match(body, /Risks: open marker risk/);
	assert.doesNotMatch(body, /Thinking[^\n]*headline: split-open headline/);

	component.handleInput("r");
	const rawBody = renderPlain(component, 100).join("\n");
	assert.match(rawBody, /\[raw\] assistant chunk #0/);
	assert.match(rawBody, /<fi/);
	assert.match(rawBody, /nal_/);
	assert.match(rawBody, /answer>/);
});

test("console Activity fallback parses final-answer closing marker split across chunks", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [
		{ index: 0, ts: now, text: "<final_answer>\nheadline: split-close headline\nrisks:\n- close marker risk\n</fi" },
		{ index: 1, ts: now + 1_000, text: "nal_" },
		{ index: 2, ts: now + 2_000, text: "answer>\nTrailing after close." },
	];
	const { component } = makeComponent({ state, rows: 70, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");
	renderPlain(component, 100);
	component.handleInput("k");

	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Final answer.*\[ok\]/);
	assert.match(body, /Headline: split-close headline/);
	assert.match(body, /Risks: close marker risk/);
	assert.match(body, /Trailing after close\./);
	assert.doesNotMatch(body, /Thinking[^\n]*headline: split-close headline/);
});

test("console Activity fallback parses character-by-character final-answer streaming", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const streamed = [
		"<final_answer>",
		"headline: char streamed headline",
		"risks:",
		"- char stream marker risk",
		"next_recommendation: keep char scanner",
		"</final_answer>",
	].join("\n");
	const chunks: AssistantChunk[] = Array.from(streamed).map((text, index) => ({ index, ts: now + index, text }));
	const { component } = makeComponent({ state, rows: 90, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	const body = renderPlain(component, 100).join("\n");
	assert.equal((body.match(/> (?:Thinking|Final answer)/g) ?? []).length, 1, body);
	assert.match(body, /Final answer.*\[ok\]/);
	assert.match(body, /Headline: char streamed headline/);
	assert.match(body, /Risks: char stream marker risk/);
	assert.match(body, /Next: keep char scanner/);
	assert.doesNotMatch(body, /Thinking[^\n]*headline: char streamed headline/);
});

test("console Activity fallback keeps unclosed final-answer tags visible as process text", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const chunks: AssistantChunk[] = [
		{ index: 0, ts: now, text: "<final_answer>\nheadline: incomplete overlay headline" },
		{ index: 1, ts: now + 1_000, text: "\nrisks:\n- missing close tag" },
	];
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });
	component.handleInput("3");

	const body = renderPlain(component, 100).join("\n");
	assert.match(body, /Thinking.*\[info\]/, "unclosed blocks should remain visible as process text");
	assert.match(body, /<final_answer>/);
	assert.match(body, /headline: incomplete overlay headline/);
	assert.doesNotMatch(body, /Final answer.*\[ok\]/, "unclosed blocks must not be synthesized as final summaries");
});

test("inspect Recent activity with worker.finalAnswer avoids duplicate final-answer body", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = "headline: split overlay headline\nrisks:\n- duplicate body risk";
	const activities: WorkerActivityEvent[] = [{
		id: "final-1",
		ts: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		actionKind: "final_summary",
		status: "completed",
		label: "Final answer",
		summary: "headline: split overlay headline risks: duplicate body risk",
		sourceEvent: "worker_text_flush",
		finalSummaryFields: { headline: "split overlay headline", risks: ["duplicate body risk"] },
	}];
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", activities: { w1: activities } });

	const lines = renderPlain(component, 100);
	const recentIndex = lines.findIndex((line) => line.includes("Recent activity"));
	const taskIndex = lines.findIndex((line) => /Task \[/.test(line));
	assert.ok(recentIndex >= 0 && taskIndex > recentIndex, `expected Recent activity before Task; got:\n${lines.join("\n")}`);
	const recentBlock = lines.slice(recentIndex, taskIndex).join("\n");
	assert.match(recentBlock, /• Final answer produced/);
	assert.doesNotMatch(recentBlock, /split overlay headline/);
	assert.doesNotMatch(recentBlock, /duplicate body risk/);
});

test("console Activity contract renders the golden command, output elision, process note, and final-answer fields", () => {
	const state = makeState(1);
	const { chunks, events } = makeActivityContractInputs();
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks }, consoles: { w1: events } });
	component.handleInput("3");

	assertRenderedSubsequence(renderPlain(component, 100), CONSOLE_ACTIVITY_GOLDEN_LINES, "Console Activity golden example");
});

test("console Raw fallback contract keeps timestamped diagnostic activity reachable", () => {
	const state = makeState(1);
	const { chunks, events } = makeActivityContractInputs();
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks }, consoles: { w1: events } });
	component.handleInput("3");
	component.handleInput("r");

	assertRenderedSubsequence(renderPlain(component, 100), CONSOLE_RAW_FALLBACK_GOLDEN_LINES, "Console Raw fallback golden example");
});

test("Console keeps tool names bold and lets operators expand earlier output", () => {
	const activities: WorkerActivityEvent[] = ["read", "bash"].map((toolName, index) => ({
		id: `tool-${index}`, ts: index, updatedAt: index + 10,
		actionKind: "tool", status: "completed", toolName, label: `Used ${toolName}`,
		summary: index === 0 ? "src/ui/overlay.ts" : "npm run typecheck",
		outputSnippet: index === 0 ? "Earlier file output" : "Latest check output",
		sourceEvent: "worker_tool_finished",
	}));
	const { component } = makeComponent({ state: makeState(1), activities: { w1: activities }, theme: makeFakeTheme() });
	component.handleInput("3");
	let rendered = component.render(100).join("\n");
	assert.match(rendered, /\x1b\[1m\x1b\[38;5;81mread/);
	assert.match(stripAnsi(rendered), /read\s+src\/ui\/overlay.ts/);
	assert.doesNotMatch(stripAnsi(rendered), /Earlier file output/);
	assert.match(stripAnsi(rendered), /Latest check output/);
	component.handleInput("k");
	let plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /> read/);
	assert.match(plain, /Earlier file output/);
	assert.doesNotMatch(plain, /Latest check output/);
	component.handleInput("\r");
	assert.doesNotMatch(renderPlain(component, 100).join("\n"), /Earlier file output/);
	component.handleInput("\r");
	assert.match(renderPlain(component, 100).join("\n"), /Earlier file output/);
	component.dispose?.();
});

test("Console colors tool categories, dims summaries, and aligns status columns", () => {
	const activities: WorkerActivityEvent[] = ["read", "grep", "bash"].map((toolName, index) => ({
		id: String(index), ts: 1, updatedAt: 2, actionKind: toolName === "bash" ? "command" : "tool", status: "completed",
		toolName, label: `Used ${toolName}`, summary: `summary-${index}`, durationMs: 12, sourceEvent: "worker_tool_finished",
	}));
	const { component } = makeComponent({ state: makeState(1), activities: { w1: activities }, theme: makeFakeTheme() });
	component.handleInput("3");
	const rendered = component.render(100);
	const text = rendered.join("\n");
	assert.match(text, /38;5;81mread/);
	assert.match(text, /38;5;141mgrep/);
	assert.match(text, /38;5;214mbash/);
	assert.match(text, /38;5;245m  summary-0/);
	assert.match(text, /38;5;120mok/);
	const selectedRow = rendered.find((line) => stripAnsi(line).includes("> bash"))!;
	assert.ok(selectedRow.includes("\x1b[48;5;237m"));
	assert.ok(!rendered.find((line) => stripAnsi(line).includes("read  summary-0"))?.includes("\x1b[48;5;237m"));
	const rows = plainLines(rendered).filter((line) => /summary-\d/.test(line));
	assert.equal(rows.length, 3);
	assert.equal(new Set(rows.map((line) => line.indexOf("[ok]"))).size, 1);
	assert.equal(new Set(rows.map((line) => line.indexOf("12ms"))).size, 1);
	const readIndex = rendered.findIndex((line) => stripAnsi(line).includes("summary-0"));
	assert.equal(stripAnsi(rendered[readIndex + 1]!).replace(/│/g, "").trim(), "");
	component.dispose?.();
});

test("selected row background survives width truncation and nested style resets", () => {
	const palette = themedPalette(makeFakeTheme());
	const text = palette.selected("read\x1b[0m…\x1b[0m [ok]");
	assert.ok(text.includes("\x1b[0m\x1b[48;5;237m…"));
	assert.ok(text.includes("\x1b[0m\x1b[48;5;237m [ok]"));
	assert.ok(text.endsWith("\x1b[49m"));
});

test("Console running animation stops on settlement, tab change, and disposal", () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let callback: (() => void) | undefined;
	let unrefs = 0;
	let clears = 0;
	let renders = 0;
	const timer = { unref: () => { unrefs += 1; } } as unknown as ReturnType<typeof setInterval>;
	globalThis.setInterval = ((fn: () => void) => { callback = fn; return timer; }) as typeof setInterval;
	globalThis.clearInterval = (() => { clears += 1; callback = undefined; }) as typeof clearInterval;
	const state = makeState(1);
	const activities: WorkerActivityEvent[] = [{ id: "running", ts: 1, updatedAt: 1, actionKind: "tool", status: "started", toolName: "read", label: "Used read", sourceEvent: "worker_tool_started" }];
	const component = createTeamDashboardOverlayComponent({ terminal: { rows: 30, columns: 100 }, requestRender: () => { renders += 1; } }, makeFakeManager({ state, activities: { w1: activities } }), state, () => {});
	try {
		component.handleInput("3");
		assert.match(renderPlain(component, 100).join("\n"), /\[running\]\s+\|/);
		assert.equal(unrefs, 1);
		renders = 0;
		callback!();
		assert.equal(renders, 1);
		assert.match(renderPlain(component, 100).join("\n"), /\[running\]\s+\//);
		assert.equal(unrefs, 1, "render must not start a second timer");
		state.activeWorkers.w1!.status = "idle";
		component.render(100);
		assert.equal(clears, 1);
		state.activeWorkers.w1!.status = "running";
		component.render(100);
		component.handleInput("1");
		component.render(100);
		assert.equal(clears, 2);
		component.handleInput("3");
		component.render(100);
		component.dispose();
		component.dispose();
		assert.equal(clears, 3);
		assert.equal(callback, undefined);
	} finally {
		component.dispose();
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("Console keeps errors expanded even when another tool is selected", () => {
	const activities: WorkerActivityEvent[] = ["error", "completed"].map((status, index) => ({
		id: `tool-${index}`, ts: index, updatedAt: index + 10,
		actionKind: "command", status: status as "error" | "completed", toolName: "bash", label: "Ran npm test",
		command: "npm test", outputSnippet: index === 0 ? "Failed to run command" : "Finished",
		sourceEvent: "worker_tool_finished",
	}));
	const { component } = makeComponent({ state: makeState(1), activities: { w1: activities } });
	component.handleInput("3");
	assert.match(renderPlain(component, 100).join("\n"), /Failed to run command/);
	component.handleInput("k");
	component.render(100);
	component.handleInput("\r");
	assert.match(renderPlain(component, 100).join("\n"), /Failed to run command/);
	component.dispose?.();
});

test("Console follows new activity by default and preserves manual selection until resumed", () => {
	const activities: WorkerActivityEvent[] = Array.from({ length: 25 }, (_, index) => ({
		id: `tool-${index}`, ts: index, updatedAt: index + 10, actionKind: "tool", status: "completed",
		toolName: "read", label: "Used read", summary: `file-${index}.ts`, sourceEvent: "worker_tool_finished",
	}));
	const { component } = makeComponent({ state: makeState(1), rows: 24, activities: { w1: activities } });
	component.handleInput("3");
	let plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /Activity · \[follow\]/);
	assert.match(plain, /> read\s+file-24.ts/);
	assert.doesNotMatch(plain, /file-0.ts/);
	component.handleInput("k");
	component.render(100);
	activities.push({ ...activities[24]!, id: "new-tool", summary: "newest-file.ts" });
	plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /Activity · \[paused\]/);
	assert.match(plain, /> read\s+file-23.ts/);
	component.handleInput("f");
	plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /Activity · \[follow\]/);
	assert.match(plain, /> read\s+newest-file.ts/);
	component.handleInput("g");
	plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /> read\s+file-0.ts/);
	component.handleInput("G");
	assert.match(renderPlain(component, 100).join("\n"), /> read\s+newest-file.ts/);
	component.dispose?.();
});

test("footer reveals secondary actions on demand and Raw shows scroll hints", () => {
	const { component } = makeComponent({ state: makeState(1) });
	let plain = renderPlain(component, 100).join("\n");
	assert.doesNotMatch(plain, /\[p\]rune/);
	component.handleInput("?");
	plain = renderPlain(component, 100).join("\n");
	for (const key of ["[m]sg", "[c]lose", "[x]cancel", "[p]rune"]) assert.ok(plain.includes(key), key);
	component.handleInput("?");
	component.handleInput("3");
	component.handleInput("r");
	plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /↑\/↓ scroll/);
	assert.doesNotMatch(plain, /enter details/);
	component.dispose?.();
});

test("roster shows task titles while Inspect honors hidden cost", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.usage.inputTokens = 9999;
	state.activeWorkers.w1!.usage.costUsd = 12.34;
	const { component } = makeComponent({ state, displayCost: false, rows: 48 });
	let plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /reviewer.*Task 1/);
	assert.doesNotMatch(plain, /in=|out=|\$12/);
	component.handleInput("2");
	plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /(?:9[,.]?999|10k) input/);
	assert.doesNotMatch(plain, /\$12/);
	component.dispose?.();
});

test("console Activity uses bold tool names and semantic diff +/- styling", () => {
	const state = makeState(1);
	const now = 1_700_000_000_000;
	const activities: WorkerActivityEvent[] = [{
		id: "a1",
		ts: now,
		updatedAt: now + 300,
		actionKind: "command",
		status: "completed",
		label: "Ran git diff --stat && git diff",
		summary: "git diff --stat && git diff",
		command: "git diff --stat && git diff",
		toolName: "bash",
		outputSnippet: [
			"src/ui/overlay.ts | 3 ++-",
			"1 file changed, 2 insertions(+), 1 deletion(-)",
			"diff --git a/src/ui/overlay.ts b/src/ui/overlay.ts",
			"--- a/src/ui/overlay.ts",
			"+++ b/src/ui/overlay.ts",
			"@@ -1,2 +1,3 @@",
			"-old line",
			"+new line",
		].join("\n"),
		sourceEvent: "worker_tool_finished",
	}];
	const { component } = makeComponent({ state, rows: 48, cols: 100, initialWorkerId: "w1", activities: { w1: activities } });
	component.handleInput("3");

	const rendered = component.render(100).join("\n");
	const plain = stripAnsi(rendered);
	assert.match(plain, /bash\s+git diff --stat && git diff\s+\[ok\]/, "expected clear tool name and command summary");
	assert.doesNotMatch(plain, /╭─ tool/, "activities should not have their own boxes");
	assert.match(rendered, /\x1b\[[0-9;]*38;5;114m\+new line\x1b\[0m/, "expected addition line success styling");
	assert.match(rendered, /\x1b\[[0-9;]*38;5;167m-old line\x1b\[0m/, "expected deletion line danger styling");
	assert.match(rendered, /\x1b\[[0-9;]*38;5;75mdiff --git/, "expected diff headers to use accent styling");
	assert.ok(plain.includes("+++ b/src/ui/overlay.ts"), "expected +++ file header prefix preserved");
	assert.ok(plain.includes("--- a/src/ui/overlay.ts"), "expected --- file header prefix preserved");
});

test("console Activity blocks remain width-safe for long commands and output", () => {
	const state = makeState(1);
	const longCommand = `npm exec tsx -- --test ${"tests/ui/overlay.test.ts ".repeat(6)}`;
	const activities: WorkerActivityEvent[] = [{
		id: "a1",
		ts: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		actionKind: "command",
		status: "started",
		label: `Ran ${longCommand}`,
		summary: longCommand,
		command: longCommand,
		toolName: "bash",
		outputSnippet: "output ".repeat(40),
		sourceEvent: "worker_tool_started",
	}];
	const { component } = makeComponent({ state, rows: 42, cols: 40, initialWorkerId: "w1", activities: { w1: activities } });
	component.handleInput("3");

	const lines = renderPlain(component, 40);
	assert.ok(lines.some((line) => line.includes("bash") && line.includes("[running]")), "expected running command block");
	assert.ok(lines.some((line) => line.includes("$ npm exec tsx")), "expected command row");
	for (const line of lines) assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${visibleWidth(line)} ${line}`);
});

test("inspect Recent activity contract renders compact recent commands, thinking, and final-answer signal", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = "headline: APPROVE — no blocking issues found.";
	const { component } = makeComponent({
		state,
		rows: 48,
		cols: 100,
		initialWorkerId: "w1",
		transcripts: { w1: "comparing overlay width behavior" },
		consoles: {
			w1: [
				{ ts: 1_700_000_000_000, kind: "tool_start", text: "grep \"buildConsoleLines\" src/ui/overlay.ts" },
				{ ts: 1_700_000_001_000, kind: "tool_start", text: "npm run typecheck" },
			],
		},
	});

	component.handleInput("\r");
	const lines = renderPlain(component, 100);
	assertRenderedSubsequence(lines, INSPECT_RECENT_ACTIVITY_GOLDEN_LINES, "Inspect Recent activity golden example");
	const statusIndex = lines.findIndex((line) => line.includes("Status"));
	const recentIndex = lines.findIndex((line) => line.includes("Recent activity"));
	const taskIndex = lines.findIndex((line) => /Task \[/.test(line));
	assert.ok(statusIndex >= 0 && recentIndex > statusIndex && taskIndex > recentIndex, `expected Recent activity near top between Status and Task; got:\n${lines.join("\n")}`);
});

test("inspect Recent activity stays compact at narrow width and does not duplicate dense transcripts", () => {
	const state = makeState(1);
	const denseTranscript = [
		"Assigned Task",
		"Goal: render every detail from a deliberately verbose prompt that should not be copied into Recent activity",
		"Context: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
		"Expected output: lots of details that belong only in Latest assistant text",
	].join("\n");
	const { component } = makeComponent({
		state,
		rows: 54,
		cols: 52,
		initialWorkerId: "w1",
		transcripts: { w1: denseTranscript },
		consoles: {
			w1: [
				{ ts: 1_700_000_000_000, kind: "tool_start", text: "grep \"buildConsoleLines\" src/ui/overlay.ts" },
				{ ts: 1_700_000_001_000, kind: "tool_start", text: "npm exec tsx -- --test tests/ui/overlay.test.ts" },
			],
		},
	});

	const lines = renderPlain(component, 52);
	const recentIndex = lines.findIndex((line) => line.includes("Recent activity"));
	const taskIndex = lines.findIndex((line) => /Task \[/.test(line));
	assert.ok(recentIndex >= 0 && taskIndex > recentIndex, `expected Recent activity before Task; got:\n${lines.join("\n")}`);
	const recentBlock = lines.slice(recentIndex, taskIndex).join("\n");
	assert.ok(recentBlock.includes("• Ran grep"), recentBlock);
	assert.ok(!recentBlock.includes("Assigned Task"), "Recent activity must not duplicate dense transcript/task prompt text");
	assert.ok(!recentBlock.includes("Goal: render every detail"), "Recent activity must stay compact");
	for (const line of lines) assert.ok(visibleWidth(line) <= 52, `line exceeds width: ${visibleWidth(line)} ${line}`);
});

test("console Activity contract stays ANSI-width-safe and wraps nested output at narrow width", () => {
	const state = makeState(1);
	const { chunks, events } = makeActivityContractInputs();
	const { component } = makeComponent({ state, rows: 48, cols: NARROW_CONSOLE_ACTIVITY_WIDTH, initialWorkerId: "w1", chunks: { w1: chunks }, consoles: { w1: events } });
	component.handleInput("3");
	renderPlain(component, NARROW_CONSOLE_ACTIVITY_WIDTH);
	component.handleInput("k");

	const lines = renderPlain(component, NARROW_CONSOLE_ACTIVITY_WIDTH);
	assertRenderedSubsequence(lines, NARROW_CONSOLE_ACTIVITY_GOLDEN_LINES, "narrow Console Activity golden example");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= NARROW_CONSOLE_ACTIVITY_WIDTH, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
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
	const { component } = makeComponent({ state, rows: 40, cols: 100, initialWorkerId: "w1", chunks: { w1: chunks } });

	component.handleInput("3");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("chunks=") || line.includes("chunk 7")));
	assert.ok(lines.some((line) => line.includes("follow ")));
	assert.ok(lines.some((line) => line.includes("chunk 7")));

	component.handleInput("\x1b[5~");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused")));

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")));

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused")), "f should toggle console follow off");

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")), "f should toggle console follow on");
});

test("inspect tab supports follow mode and mac-friendly scroll aliases", () => {
	const state = makeState(1);
	const transcript = Array.from({ length: 30 }, (_, i) => `assistant line ${i}`).join("\n");
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1", transcripts: { w1: transcript } });

	component.handleInput("\r");
	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused")), "Inspect should start in manual scroll mode");
	assert.ok(!lines.some((line) => line.includes("assistant line 29")), "tail should not be visible before jumping bottom");

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")), "G should jump bottom and follow");
	assert.ok(lines.some((line) => line.includes("assistant line 29")), "bottom should show latest assistant text");

	component.handleInput("b");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused")), "b should page up and pause follow");

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")), "f should toggle Inspect follow back on");
});

test("Inspect and Console chrome stays compact at laptop panel width", () => {
	const state = makeState(1);
	const transcript = Array.from({ length: 40 }, (_, i) => `assistant line ${i}`).join("\n");
	const chunks: AssistantChunk[] = Array.from({ length: 40 }, (_, i) => ({ index: i, ts: Date.now() + i, text: `chunk ${i}` }));
	const { component } = makeComponent({ state, rows: 30, cols: 80, initialWorkerId: "w1", transcripts: { w1: transcript }, chunks: { w1: chunks } });

	for (const [tabKey, label] of [["2", "Inspect"], ["3", "Console"]] as const) {
		component.handleInput(tabKey);
		let lines = renderPlain(component, 80);
		const helpLine = lines.find((line) => line.includes("space/b") && line.includes("g/G"));
		assert.ok(helpLine, `expected compact ${label} help row`);
		assert.ok(!helpLine.includes("…"), helpLine);
		assert.ok(!helpLine.includes("q quit"), helpLine);

		if (tabKey === "2") {
			component.handleInput("G");
			lines = renderPlain(component, 80);
		}
		const followLine = lines.find((line) => line.includes("[follow]") && line.includes("scroll"));
		assert.ok(followLine, `expected compact ${label} follow header`);
		assert.match(followLine, /\[follow\]\s+scroll \d+-\d+ \/ \d+/, followLine);
		assert.ok(!followLine.includes("…"), followLine);
		assert.ok(visibleWidth(followLine) <= 80, followLine);

		component.handleInput("b");
		lines = renderPlain(component, 80);
		const pausedLine = lines.find((line) => line.includes("[paused]") && line.includes("scroll"));
		assert.ok(pausedLine, `expected compact ${label} paused header`);
		assert.match(pausedLine, /\[paused\]\s+scroll \d+-\d+ \/ \d+/, pausedLine);
		assert.ok(!pausedLine.includes("…"), pausedLine);
		assert.ok(visibleWidth(pausedLine) <= 80, pausedLine);
	}
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
	assert.ok(lines.some((line) => line.includes("143.5k input") && line.includes("1.3m output")), "expected compact aggregate token counts");
	assert.ok(lines.some((line) => line.includes("$0.3000")), "cost precision should remain monetary");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("reviewer") && /123\.5k\s+50k/.test(line)));
	assert.ok(!lines.some((line) => line.includes("Cache")), `zero-cache workers should stay uncluttered; got:\n${lines.join("\n")}`);
});

test("cost tab shows cache metrics for aggregate, retained, and per-worker usage", () => {
	const state = makeState(2);
	state.activeWorkers.w1!.usage = { ...state.activeWorkers.w1!.usage, turns: 3, inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 12_000, cacheWriteTokens: 500, costUsd: 0.25 };
	state.activeWorkers.w2!.usage = { ...state.activeWorkers.w2!.usage, turns: 1, inputTokens: 20_000, outputTokens: 1_250_000, cacheReadTokens: 3_000, cacheWriteTokens: 0, costUsd: 0.05 };
	state.prunedWorkerUsageTotals = {
		workers: 1,
		turns: 2,
		inputTokens: 10_000,
		outputTokens: 5_000,
		cacheReadTokens: 1_000,
		cacheWriteTokens: 100,
		costUsd: 0.01,
		contextTokens: 0,
	};
	const { component } = makeComponent({ state, rows: 30, cols: 120 });
	component.handleInput("4");
	const lines = renderPlain(component, 120);
	assert.ok(lines.some((line) => line.includes("16k read") && line.includes("600 written")), `expected aggregate cache totals; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("Pruned (1)") && /1k\s+100/.test(line)), "expected retained cache totals");
	assert.ok(lines.some((line) => line.includes("w1") && /12k\s+500/.test(line)), "expected per-worker cache totals");
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
	assert.ok(lines.some((line) => line.includes("120k input") && line.includes("1.3m output")), "expected active plus retained aggregate totals");
	assert.ok(lines.some((line) => line.includes("Pruned (2)") && line.includes("20k")), "expected retained/pruned note");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("100k")), "expected active per-worker row to remain visible");
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
	assert.ok(lines.some((line) => line.includes("20k input") && line.includes("1.3m output")), "expected retained-only aggregate totals");
	assert.ok(lines.some((line) => line.includes("Pruned (2)")), "expected retained/pruned note");
	assert.ok(!lines.some((line) => /\bw\d+\b/.test(line)), "expected no per-worker rows");
});

test("inspect tab usage line uses compact tokens, cache metrics, and context budget", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.usage = {
		...state.activeWorkers.w1!.usage,
		turns: 7,
		inputTokens: 1_250_000,
		outputTokens: 12_345,
		cacheReadTokens: 12_345,
		cacheWriteTokens: 600,
		costUsd: 1.2345,
		contextTokens: 128_000,
		contextWindow: 200_000,
		contextPercent: 64,
		contextRemainingTokens: 72_000,
	};
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1" });
	const lines = renderPlain(component, 100);
	const body = lines.join("\n");
	assert.match(body, /Turns: 7/);
	assert.match(body, /Tokens: 1\.3m input · 12\.3k output/);
	assert.match(body, /Cache: 12\.3k read · 600 written/);
	assert.match(body, /Cost: \$1\.2345/);
	assert.match(body, /Context: 64% used · 200k window · 72k remaining/);
});

test("cost tab compact large token counts do not exceed terminal width", () => {
	const state = makeState(3);
	state.activeWorkers.w1!.usage = { ...state.activeWorkers.w1!.usage, turns: 99_999, inputTokens: 987_654_321, outputTokens: 123_456_789, costUsd: 1234.5678 };
	state.activeWorkers.w2!.usage = { ...state.activeWorkers.w2!.usage, turns: 88_888, inputTokens: 876_543_210, outputTokens: 9_876_543, costUsd: 987.6543 };
	state.activeWorkers.w3!.usage = { ...state.activeWorkers.w3!.usage, turns: 77_777, inputTokens: 765_432_109, outputTokens: 8_765_432, costUsd: 876.5432 };
	const wide = makeComponent({ state, rows: 32, cols: 120 });
	wide.component.handleInput("4");
	assert.ok(renderPlain(wide.component, 120).some((line) => line.includes("987.7m")), "expected compact million-scale Cost tab tokens");

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
	for (const termRows of [5, 14, 15, 30, 40, 60, 80]) {
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
	const { component } = makeComponent({ state, rows: 48, cols: 60, initialWorkerId: "w1" });
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

test("Workers and Cost refresh when an unselected worker changes", () => {
	const options: FakeManagerOptions = { state: makeState(2), activityListeners: [] };
	let renders = 0;
	const component = createTeamDashboardOverlayComponent({ terminal: { rows: 30, columns: 100 }, requestRender: () => { renders += 1; } }, makeFakeManager(options), options.state, () => {}, { initialWorkerId: "w1" });
	for (const tab of ["1", "4"]) {
		component.handleInput(tab);
		renders = 0;
		options.activityListeners![0]!("w2", { id: "updated", ts: 1, updatedAt: 1, actionKind: "status", status: "info", label: "Worker idle", sourceEvent: "worker_settled" });
		assert.equal(renders, 1);
	}
	component.dispose();
});

test("Inspect keeps questions and results ahead of long details and reads transcripts only on demand", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.currentTask!.goal = "Long instruction ".repeat(400);
	state.activeWorkers.w1!.pendingRelayQuestions = [{ question: "Approve the migration?", assumption: "Wait", urgency: "high", createdAt: 1 }];
	state.activeWorkers.w1!.finalAnswer = "headline: Ready for review";
	const manager = makeFakeManager({ state });
	let reads = 0;
	(manager as unknown as { getWorkerTranscript: () => string }).getWorkerTranscript = () => { reads += 1; return "Retained report text"; };
	const component = createTeamDashboardOverlayComponent({ terminal: { rows: 36, columns: 80 } }, manager, state, () => {}, { initialWorkerId: "w1" });
	let plain = renderPlain(component, 80).join("\n");
	assert.match(plain, /Approve the migration\?/);
	assert.match(plain, /Ready for review/);
	assert.doesNotMatch(plain, /Long instruction|Retained report text/);
	assert.equal(reads, 0);
	component.handleInput("\r");
	component.handleInput("G");
	plain = renderPlain(component, 80).join("\n");
	assert.match(plain, /Retained report text/);
	assert.ok(reads > 0);
	component.handleInput("\r");
	plain = renderPlain(component, 80).join("\n");
	assert.doesNotMatch(plain, /Retained report text/);
	assert.match(plain, /Approve the migration\?/);
	component.dispose();
});

test("Workers shares Console selection styling and adapts its aligned table to stacked tasks", () => {
	const state = makeState(3);
	state.activeWorkers.w1!.currentTask!.title = "Verify the worker lifecycle and cancellation behavior";
	state.activeWorkers.w2!.status = "idle";
	state.activeWorkers.w2!.finalAnswer = "Ready";
	state.activeWorkers.w3!.status = "error";
	const { component, tui } = makeComponent({ state, rows: 40, cols: 110, theme: makeFakeTheme() });
	let rendered = component.render(110);
	assert.ok(rendered.some((line) => /Worker\s+Status\s+Task\s+Time/.test(stripAnsi(line))));
	const selected = rendered.find((line) => stripAnsi(line).includes("> w3"))!;
	assert.ok(selected.includes("\x1b[48;5;237m"));
	assert.ok(rendered.some((line) => line.includes("\x1b[38;5;120mDone [reuse]")));
	component.handleInput("j");
	tui.terminal.columns = 44;
	rendered = component.render(44);
	const plain = plainLines(rendered).join("\n");
	assert.match(plain, /> w1/);
	assert.match(plain, /Verify the worker lifecycle/);
	assert.doesNotMatch(plain, /Worker\s+Status\s+Task\s+Time/);
	for (const line of rendered) assert.ok(visibleWidth(line) <= 44);
	assert.equal(rendered.length, Math.floor(40 * 0.9));
	component.dispose();
});

test("Cost keeps totals and column labels visible while scrolling and retains exact amounts when stacked", () => {
	const state = makeState(24);
	for (const worker of Object.values(state.activeWorkers)) worker.usage.costUsd = 0.125;
	const { component, tui } = makeComponent({ state, rows: 28, cols: 100, initialWorkerId: "w1", theme: makeFakeTheme() });
	component.handleInput("4");
	component.handleInput("G");
	let plain = renderPlain(component, 100).join("\n");
	assert.match(plain, /Σ Agent total\s+\$3\.0000/);
	assert.match(plain, /Worker\s+Turns\s+Input\s+Output\s+Cost/);
	assert.match(plain, /w24/);
	component.handleInput("g");
	tui.terminal.columns = 44;
	plain = renderPlain(component, 44).join("\n");
	assert.match(plain, /Σ Agent total\s+\$3\.0000/);
	assert.match(plain, /Cost: \$0\.1250/);
	assert.match(plain, /Turns:/);
	for (const line of component.render(44)) assert.ok(visibleWidth(line) <= 44);
	component.dispose();
});

test("all tabs keep navigation and selected workers inside resized terminal row budgets", () => {
	const state = makeState(25);
	const { component, tui } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w24" });
	for (const columns of [20, 44, 76, 120]) {
		for (const rows of [14, 30, 50]) {
			tui.terminal.columns = columns;
			tui.terminal.rows = rows;
			for (const tab of ["1", "2", "3", "4"]) {
				component.handleInput(tab);
				const rendered = component.render(columns);
				assert.equal(rendered.length, Math.floor(rows * 0.9));
				for (const line of rendered) assert.ok(visibleWidth(line) <= columns);
				if (tab === "1" && columns >= 44) assert.ok(plainLines(rendered).some((line) => line.includes("> w24")));
			}
		}
	}
	component.dispose();
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
	for (const termRows of [5, 14, 15, 30, 40]) {
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

test("inspect wraps non-breakable long tokens on narrow panels without dropping content", () => {
	const state = makeState(1);
	const longToken = "x".repeat(400);
	state.activeWorkers.w1!.finalAnswer = `prefix ${longToken} suffix`;
	const { component } = makeComponent({ state, rows: 80, cols: 48, initialWorkerId: "w1" });

	const lines = renderPlain(component, 48);
	const xRuns = lines.filter((line) => /x{4,}/.test(line));
	assert.ok(xRuns.length >= 3, `expected unbreakable token to wrap onto multiple rows, got runs:\n${xRuns.join("\n")}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 48, `line exceeds width: ${visibleWidth(line)} ${line}`);
	}
	assert.ok(!xRuns.some((line) => line.includes("…")), "wrapping should not ellipsize the long token");
	const totalXVisible = xRuns.reduce((sum, line) => sum + (line.match(/x/g)?.length ?? 0), 0);
	assert.ok(totalXVisible >= 200, `expected most of the long token to remain visible across wrap chunks, saw ${totalXVisible}`);
});

test("classifier matches structural patterns after worker ANSI has been sanitized", () => {
	const state = makeState(1);
	const styledHeading = "\x1b[32m# Heading from tool\x1b[0m";
	state.activeWorkers.w1!.finalAnswer = styledHeading;
	const { component } = makeComponent({ state, rows: 40, cols: 60, initialWorkerId: "w1" });

	const rawLines = component.render(60);
	assert.ok(
		rawLines.some((line) => line.includes("\x1b[1;38;5;75m") && line.includes("# Heading from tool")),
		"expected trusted accentBold styling to wrap a sanitized heading",
	);
	assert.ok(!rawLines.map(stripAnsi).join("\n").includes("\x1b"), "expected worker ANSI escapes to be removed after trusted styling is stripped");
});

test("tiny terminals surface a 'terminal too small' hint instead of silently blank chrome", () => {
	const state = makeState(1);
	const { component } = makeComponent({ state, rows: 5, cols: 60, initialWorkerId: "w1" });
	const lines = renderPlain(component, 60);
	assert.equal(lines.length, Math.floor(5 * 0.9));
	assert.ok(lines[0].startsWith("╭"), "top frame retained");
	assert.ok(lines[lines.length - 1].startsWith("╰"), "bottom frame retained");
	assert.ok(
		lines.some((line) => line.includes("(terminal too small)")),
		`expected tiny-terminal hint, got:\n${lines.join("\n")}`,
	);
});

test("sanitizeText strips BEL and backspace but preserves ESC for trusted styling", () => {
	assert.equal(sanitizeText("a\x07b"), "ab");
	assert.equal(sanitizeText("a\x08b"), "ab");
	assert.ok(sanitizeText("\x1b[31mred\x1b[0m").includes("\x1b"), "expected ESC sequences to survive");
});

test("Console uses Pi's recorded tool duration instead of event arrival time", () => {
	for (const durationMs of [0, 1250, undefined]) {
		const { component } = makeComponent({
			state: makeState(1), rows: 40, cols: 100, initialWorkerId: "w1",
			activities: { w1: [{
				id: "recorded-duration", ts: 1000, updatedAt: 10000,
				actionKind: "tool", status: "completed", label: "Used read",
				toolName: "read", sourceEvent: "worker_tool_finished", durationMs,
			}] },
		});
		component.handleInput("3");
		const rendered = renderPlain(component, 100).join("\n");
		const duration = durationMs === undefined ? "9.0s" : durationMs === 0 ? "0ms" : "1.3s";
		assert.ok(rendered.includes(duration), rendered);
		component.dispose();
	}
});

test("sanitizeTerminalText strips hostile OSC, CSI, ESC, and control sequences from worker text", () => {
	const hostile = "start\x1b]52;c;Y2xpcA==\x07clip\x1b]0;owned\x1b\\title\x1b[2Jclear\x1b[10;5Hmove\x1b[31mred\x1b[0m\x07end";
	assert.equal(sanitizeTerminalText(hostile), "startcliptitleclearmoveredend");
	assert.equal(sanitizeTerminalText("safe\rspoof"), "safespoof");
});

test("inspect and console render worker terminal escapes inertly while preserving trusted theme styling", () => {
	const state = makeState(1);
	const hostile = "safe \x1b]52;c;Y2xpcA==\x07clip \x1b]0;owned\x1b\\title \x1b[2Jclear \x1b[10;5Hmove \x1b[31mred\x1b[0m end";
	state.activeWorkers.w1!.finalAnswer = `# Report\n${hostile}`;
	state.activeWorkers.w1!.lastSummary = {
		...state.activeWorkers.w1!.lastSummary!,
		headline: hostile,
		risks: [hostile],
		nextRecommendation: hostile,
	};
	const activities: WorkerActivityEvent[] = [{
		id: "hostile-activity",
		ts: 1_700_000_000_000,
		updatedAt: 1_700_000_000_500,
		actionKind: "command",
		status: "completed",
		label: `Ran ${hostile}`,
		summary: hostile,
		command: hostile,
		outputSnippet: hostile,
		sourceEvent: "worker_tool_finished",
	}];
	const events: WorkerConsoleEvent[] = [
		{ ts: 1_700_000_000_000, kind: "tool_start", text: hostile },
		{ ts: 1_700_000_000_500, kind: "tool_end", text: hostile },
	];
	const { component } = makeComponent({
		state,
		rows: 120,
		cols: 100,
		initialWorkerId: "w1",
		transcripts: { w1: hostile },
		chunks: { w1: [{ index: 0, ts: 1_700_000_000_000, text: hostile }] },
		consoles: { w1: events },
		activities: { w1: activities },
		theme: makeFakeTheme(),
	});

	let rendered = component.render(100).join("\n");
	assert.ok(rendered.includes("\x1b[38;5;201m"), "expected trusted theme accent styling to remain");
	assert.ok(!stripAnsi(rendered).includes("\x1b"), `expected no untrusted terminal escapes in inspect render:\n${stripAnsi(rendered)}`);
	assert.ok(stripAnsi(rendered).includes("clip title clear move red end"), "expected sanitized worker text content to remain");

	component.handleInput("3");
	rendered = component.render(100).join("\n");
	assert.ok(rendered.includes("\x1b[38;5;201m"), "expected trusted theme accent styling to remain in console activity");
	assert.ok(!stripAnsi(rendered).includes("\x1b"), `expected no untrusted terminal escapes in console activity:\n${stripAnsi(rendered)}`);

	component.handleInput("r");
	rendered = component.render(100).join("\n");
	assert.ok(!stripAnsi(rendered).includes("\x1b"), `expected no untrusted terminal escapes in console raw:\n${stripAnsi(rendered)}`);
});
