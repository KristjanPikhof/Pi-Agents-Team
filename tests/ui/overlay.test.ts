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
import { stripAnsi } from "../../src/ui/theme";
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
		success: "38;5;120",
		warning: "38;5;214",
		error: "38;5;196",
	};
	return {
		fg: (role: string, text: string) => `\x1b[${roleCodes[role] ?? "39"}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[0m`,
	} as unknown as Theme;
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
	const selectedRow = lines.find((line) => line.includes("▶"));
	assert.ok(selectedRow, "expected selection arrow on a row");
});

test("workers tab keeps the selected worker visible on short overlays", () => {
	const state = makeState(35);
	const { component } = makeComponent({ state, rows: 20, cols: 100, initialWorkerId: "w30" });

	component.handleInput("1");
	const lines = renderPlain(component, 100);
	const selectedRow = lines.find((line) => line.includes("▶"));
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
	assert.match(body, /workers 4 .*Needs reply 1 .*Needs recovery 1 .*Working 1 .*Done 1/);
	assert.match(body, /selected: w1 .*Running .*Needs reply .*action: Answer relay/);
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
	assert.ok(rawLines.some((line) => line.includes("\x1b[1;38;5;75mStatus\x1b[0m")), "expected styled Status header");
	assert.ok(rawLines.some((line) => line.includes("\x1b[2mThinking:\x1b[0m")), "expected dimmed metadata label");
});

test("inspect tab visually separates final answer from latest assistant text and remains width-safe", () => {
	const state = makeState(1);
	state.activeWorkers.w1!.finalAnswer = `Final answer ${"alpha beta ".repeat(18)}`;
	const { component } = makeComponent({
		state,
		rows: 52,
		cols: 58,
		initialWorkerId: "w1",
		transcripts: { w1: `Latest assistant ${"gamma delta ".repeat(18)}` },
	});

	const lines = renderPlain(component, 58);
	const finalIndex = lines.findIndex((line) => line.includes("── Final answer ──"));
	const latestIndex = lines.findIndex((line) => line.includes("Latest assistant text"));
	assert.ok(finalIndex >= 0, "expected Final answer header");
	assert.ok(latestIndex > finalIndex, "expected Latest assistant text after Final answer");
	assert.ok(lines.slice(finalIndex + 1, latestIndex).some((line) => line.includes("Final answer alpha")), "expected final answer content under its header");
	assert.ok(lines.slice(latestIndex + 1).some((line) => line.includes("Latest assistant gamma")), "expected latest assistant text content under its header");
	assert.ok(lines[finalIndex]!.includes("── Final answer ──"), lines[finalIndex]);
	assert.ok(lines[latestIndex]!.includes("── Latest assistant text ──"), lines[latestIndex]);
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
	const wrapped = lines.filter((line) => line.includes("veryLongIdentifier") || line.includes("const result"));
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
	const { component } = makeComponent({ state, rows: 44, cols: 50, initialWorkerId: "w1" });

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

	const lines = renderPlain(component, 100);
	assertRenderedSubsequence(lines, INSPECT_RECENT_ACTIVITY_GOLDEN_LINES, "Inspect Recent activity golden example");
	const statusIndex = lines.findIndex((line) => line.includes("Status"));
	const recentIndex = lines.findIndex((line) => line.includes("Recent activity"));
	const taskIndex = lines.findIndex((line) => line.includes("Task"));
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
	const taskIndex = lines.findIndex((line) => line.includes("Task"));
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
	assert.ok(lines.some((line) => line.includes("paused f/G")));

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")));

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused f/G")), "f should toggle console follow off");

	component.handleInput("f");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")), "f should toggle console follow on");
});

test("inspect tab supports follow mode and mac-friendly scroll aliases", () => {
	const state = makeState(1);
	const transcript = Array.from({ length: 30 }, (_, i) => `assistant line ${i}`).join("\n");
	const { component } = makeComponent({ state, rows: 30, cols: 100, initialWorkerId: "w1", transcripts: { w1: transcript } });

	let lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused f/G")), "Inspect should start in manual scroll mode");
	assert.ok(!lines.some((line) => line.includes("assistant line 29")), "tail should not be visible before jumping bottom");

	component.handleInput("G");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("follow ")), "G should jump bottom and follow");
	assert.ok(lines.some((line) => line.includes("assistant line 29")), "bottom should show latest assistant text");

	component.handleInput("b");
	lines = renderPlain(component, 100);
	assert.ok(lines.some((line) => line.includes("paused f/G")), "b should page up and pause follow");

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
		const pausedLine = lines.find((line) => line.includes("[paused f/G]") && line.includes("scroll"));
		assert.ok(pausedLine, `expected compact ${label} paused header`);
		assert.match(pausedLine, /\[paused f\/G\]\s+scroll \d+-\d+ \/ \d+/, pausedLine);
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
	assert.ok(lines.some((line) => line.includes("in=143.5k") && line.includes("out=1.3m")), "expected compact aggregate token counts");
	assert.ok(lines.some((line) => line.includes("$0.3000")), "cost precision should remain monetary");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("reviewer") && line.includes("in=123.5k") && line.includes("out=50k")));
	assert.ok(!lines.some((line) => line.includes("cache=")), `zero-cache workers should stay uncluttered; got:\n${lines.join("\n")}`);
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
	assert.ok(lines.some((line) => line.includes("Σ workers=3") && line.includes("cache=r16k/w600")), `expected aggregate cache totals; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("retained/pruned") && line.includes("cache=r1k/w100")), "expected retained cache totals");
	assert.ok(lines.some((line) => line.includes("w1") && line.includes("cache=r12k/w500")), "expected per-worker cache totals");
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
	const usageLine = lines.find((line) => line.includes("turns=7"));
	assert.ok(usageLine, "expected usage line in Inspect tab");
	assert.ok(usageLine.includes("in=1.3m"), usageLine);
	assert.ok(usageLine.includes("out=12.3k"), usageLine);
	assert.ok(usageLine.includes("cache=r12.3k/w600"), usageLine);
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

test("classifier matches structural patterns even when worker text is ANSI-styled", () => {
	const state = makeState(1);
	const styledHeading = "\x1b[32m# Heading from tool\x1b[0m";
	state.activeWorkers.w1!.finalAnswer = styledHeading;
	const { component } = makeComponent({ state, rows: 40, cols: 60, initialWorkerId: "w1" });

	const rawLines = component.render(60);
	assert.ok(
		rawLines.some((line) => line.includes("\x1b[1;38;5;75m") && line.includes("# Heading from tool")),
		"expected accentBold styling to wrap an ANSI-prefixed heading",
	);
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

test("sanitizeText strips BEL and backspace but preserves ESC", () => {
	assert.equal(sanitizeText("a\x07b"), "ab");
	assert.equal(sanitizeText("a\x08b"), "ab");
	assert.ok(sanitizeText("\x1b[31mred\x1b[0m").includes("\x1b"), "expected ESC sequences to survive");
});
