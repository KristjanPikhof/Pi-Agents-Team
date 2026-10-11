import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SPINNER_FRAMES, TEAM_STATUS_TIPS, buildTeamStatusLine, buildTeamWidgetLines, getTeamStatusTip, hasAnimatedWorkers } from "../../src/ui/status-widget";
import { stripAnsi } from "../../src/ui/theme";
import type { WorkerRuntimeState, WorkerStatus } from "../../src/types";

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

test("status widget hides itself when no workers are tracked", () => {
	const state = createDefaultTeamState();
	const statusLine = buildTeamStatusLine(state);
	assert.equal(statusLine, "Orchestrator · Idle");
	assert.deepEqual(buildTeamWidgetLines(state), []);
});

test("status line shows routing mode, orchestrator state, and optional rotating tip", () => {
	const state = createDefaultTeamState();
	assert.equal(buildTeamStatusLine(state), "Orchestrator · Idle");
	assert.equal(buildTeamStatusLine(state, "solo"), "Orchestrator · Solo · Idle");
	assert.equal(buildTeamStatusLine(state, "team", getTeamStatusTip(0)), "Orchestrator · Idle · Tip: Use /team to view workers");
	assert.equal(buildTeamStatusLine(state, "team", getTeamStatusTip(0), true), "Orchestrator · Working... · Tip: Use /team to view workers");
	assert.equal(buildTeamStatusLine(state, "solo", undefined, true), "Orchestrator · Solo · Working...");

	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "running" });
	assert.equal(buildTeamStatusLine(state), "Orchestrator · Working...");
	assert.equal(buildTeamStatusLine(state, "solo"), "Orchestrator · Solo · Working...");
	assert.equal(buildTeamStatusLine(state, "team", getTeamStatusTip(1)), "Orchestrator · Working... · Tip: Use /team-result <id> for final output");

	state.activeWorkers.w1.status = "idle";
	assert.equal(buildTeamStatusLine(state), "Orchestrator · Idle");

	state.relayQueue = [{
		relayId: "r1",
		workerId: "w1",
		taskId: "t1",
		question: "Need a decision?",
		assumption: "wait",
		urgency: "normal",
		createdAt: Date.now(),
	}];
	assert.equal(buildTeamStatusLine(state), "Orchestrator · Working...");
});

test("status line and widget use the supplied Theme palette roles", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", profileName: "reviewer", status: "running" });
	const theme = makeFakeTheme();

	const statusLine = buildTeamStatusLine(state, "team", getTeamStatusTip(0), false, theme);
	assert.match(statusLine, /\x1b\[38;5;214mWorking\.\.\./, "expected warning role for working status");
	assert.match(statusLine, /\x1b\[38;5;244mTip:/, "expected dim role for tip label");

	const lines = buildTeamWidgetLines(state, { frame: 0, theme });
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;201mPi Agents Team")), `expected accent role in widget header; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("\x1b[1m\x1b[38;5;201mreviewer")), `expected bold accent role for worker profile; got:\n${lines.join("\n")}`);
	assert.ok(!lines.some((line) => line.includes("\x1b[38;5;75m")), "expected no legacy accent fallback when a full Theme is supplied");
});

test("widget prioritizes failures, animates running rows, and summarizes finished workers", () => {
	const state = createDefaultTeamState();
	state.activeWorkers = {
		w1: makeWorker({
			workerId: "w1",
			profileName: "explorer",
			status: "running",
			lastSummary: {
				workerId: "w1",
				taskId: "t1",
				headline: "mapping src/runtime",
				status: "running",
				readFiles: [],
				changedFiles: [],
				risks: [],
				relayQuestionCount: 0,
				updatedAt: Date.now(),
			},
		}),
		w2: makeWorker({
			workerId: "w2",
			profileName: "librarian",
			status: "idle",
			finalAnswer: "headline: done",
			lastSummary: {
				workerId: "w2",
				taskId: "t2",
				headline: "architecture notes ready",
				status: "idle",
				readFiles: [],
				changedFiles: [],
				risks: [],
				relayQuestionCount: 0,
				updatedAt: Date.now(),
			},
		}),
		w3: makeWorker({
			workerId: "w3",
			profileName: "fixer",
			status: "error",
			error: "boom",
		}),
	};

	const frame0 = buildTeamWidgetLines(state, { frame: 0 });
	const frame3 = buildTeamWidgetLines(state, { frame: 3 });
	const plainFrame0 = frame0.map(stripAnsi);
	const plainFrame3 = frame3.map(stripAnsi);
	const w1Frame0 = plainFrame0.find((line) => line.includes("explorer (w1)"));
	const w1Frame3 = plainFrame3.find((line) => line.includes("explorer (w1)"));
	assert.ok(w1Frame0?.startsWith(`${SPINNER_FRAMES[0]} `));
	assert.ok(w1Frame3?.startsWith(`${SPINNER_FRAMES[3]} `));
	assert.match(frame0.find((line) => stripAnsi(line).includes("explorer (w1)")) ?? "", /\x1b\[1mexplorer\x1b\[0m \(w1\)/);
	assert.match(w1Frame0 ?? "", /explorer \(w1\)\s+mapping src\/runtime\s+0s$/);
	assert.ok(!w1Frame0?.includes(" — "));

	const w2Line = plainFrame0.find((line) => line.includes("librarian (w2)"));
	assert.equal(w2Line, undefined, "finished rows must not compete with current work");

	const w3Line = plainFrame0.find((line) => line.includes("fixer (w3)"));
	assert.ok(w3Line?.startsWith("✗ "));
	assert.ok(plainFrame0.indexOf(w3Line!) < plainFrame0.indexOf(w1Frame0!));

	assert.equal(plainFrame0.filter((line) => line.includes("mapping src/runtime")).length, 1, "routine summaries should not repeat the task row");
	assert.ok(plainFrame0.some((line) => line.trim() === "boom"), "failure detail must remain visible");
	assert.ok(!plainFrame0.some((line) => line.includes("Done: architecture notes ready")), `expected no done detail line; got:\n${plainFrame0.join("\n")}`);
	assert.ok(!plainFrame0.some((line) => /└ (in_progress|completed_or_idle):/.test(line)), `expected no raw attention keys; got:\n${plainFrame0.join("\n")}`);

	const countsLine = plainFrame0.join("\n");
	assert.match(countsLine, /1 running/);
	assert.match(countsLine, /1 done/);
	assert.match(countsLine, /1 needs recovery/);
	assert.doesNotMatch(countsLine, /All agents finished|● Agents|active=/);
});

test("widget caps active rows and reports hidden workers", () => {
	const state = createDefaultTeamState();
	for (let i = 1; i <= 20; i += 1) {
		const id = `w${i}`;
		state.activeWorkers[id] = makeWorker({
			workerId: id,
			profileName: "reviewer",
			status: "running",
			lastSummary: {
				workerId: id,
				taskId: `t${i}`,
				headline: `detail for ${id} — ${"x".repeat(120)}`,
				status: "running",
				readFiles: [],
				changedFiles: [],
				risks: [],
				relayQuestionCount: 0,
				updatedAt: Date.now(),
			},
		});
	}

	const lines = buildTeamWidgetLines(state, { frame: 0 });
	const plainLines = lines.map(stripAnsi);
	const workerRows = plainLines.filter((line) => / reviewer \(w\d+\) /.test(line));
	assert.equal(workerRows.length, 8);
	assert.ok(lines.some((line) => /\+ 12 active/.test(line)), "overflow must identify hidden live workers");

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 100, `line exceeds 100 cols (${visibleWidth(line)}): ${line}`);
	}
});

test("twelve finished workers cannot hide the five newly running workers from the screenshot", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	for (let index = 1; index <= 17; index += 1) {
		const workerId = `w${index}`;
		state.activeWorkers[workerId] = makeWorker({
			workerId,
			status: index <= 12 ? "idle" : "running",
			finalAnswer: index <= 12 ? "Inventory complete" : undefined,
			startedAt: now - 3_000,
			lastEventAt: now,
		});
	}
	const lines = buildTeamWidgetLines(state, { now }).map(stripAnsi);
	const rows = lines.filter((line) => /\(w\d+\)/.test(line));
	assert.deepEqual(rows.map((line) => line.match(/\((w\d+)\)/)?.[1]), ["w13", "w14", "w15", "w16", "w17"]);
	assert.match(lines[0]!, /5 running.*12 done/);
	assert.doesNotMatch(lines.join("\n"), /All agents finished|\+ \d+ active|● Agents|active=/);
	assert.equal(lines.length, 6, "one heading and one row per running worker");
});

test("all-finished preview collapses to the result shortcut and stale output cannot finish a reused worker", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "idle", finalAnswer: "Ready" });
	state.activeWorkers.w2 = makeWorker({ workerId: "w2", status: "completed", finalAnswer: "Ready" });
	let lines = buildTeamWidgetLines(state, { theme: makeFakeTheme() });
	assert.match(stripAnsi(lines[0]!), /All agents finished.*2 done/);
	assert.match(lines[0]!, /\x1b\[38;5;120m✓ All agents finished/);
	assert.match(stripAnsi(lines[1]!), /\/team-result <id>/);
	assert.equal(lines.length, 2);
	assert.equal(hasAnimatedWorkers(state), false);
	state.activeWorkers.w2.status = "running";
	lines = buildTeamWidgetLines(state, { theme: makeFakeTheme() });
	assert.doesNotMatch(lines.join("\n"), /All agents finished/);
	assert.match(stripAnsi(lines[0]!), /1 running.*1 done/);
	assert.ok(lines.some((line) => stripAnsi(line).includes("(w2)")));
	assert.equal(hasAnimatedWorkers(state), true);
});

test("idle without a result and old failures never show a successful all-finished banner", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "idle", lastEventAt: now });
	state.activeWorkers.w2 = makeWorker({ workerId: "w2", status: "error", error: "Old failure", lastEventAt: now - 10 * 60_000 });
	const lines = buildTeamWidgetLines(state, { now }).map(stripAnsi);
	assert.match(lines.join("\n"), /1 needs recovery.*1 idle/);
	assert.doesNotMatch(lines.join("\n"), /All agents finished|\(w2\)|Old failure/);
	assert.match(lines.join("\n"), /\/team for worker details/);
});

test("questions and failures use warning and error theme colors before running rows", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "running", startedAt: now - 3_000 });
	state.activeWorkers.w9 = makeWorker({
		workerId: "w9", status: "waiting_followup", startedAt: now - 3_000,
		pendingRelayQuestions: [{ question: "Choose the cleanup scope", assumption: "Wait", urgency: "normal", createdAt: now }],
	});
	state.activeWorkers.w10 = makeWorker({
		workerId: "w10", status: "error", startedAt: now - 30_000, lastEventAt: now - 10_000, error: "RPC crashed",
		lastSummary: { workerId: "w10", headline: "Old progress", status: "running", readFiles: [], changedFiles: [], risks: [], relayQuestionCount: 0, updatedAt: now - 20_000 },
	});
	const lines = buildTeamWidgetLines(state, { now, theme: makeFakeTheme() });
	const plain = lines.map(stripAnsi);
	const rows = plain.filter((line) => /\(w\d+\)/.test(line));
	assert.deepEqual(rows.map((line) => line.match(/\((w\d+)\)/)?.[1]), ["w9", "w10", "w1"]);
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;214mNeeds reply")));
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;214mChoose the cleanup scope")));
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;196mNeeds recovery")));
	assert.ok(lines.some((line) => line.includes("\x1b[38;5;196mRPC crashed")));
	assert.match(rows[1]!, /20s$/, "terminal elapsed time must stop at the last event");
	assert.doesNotMatch(plain.join("\n"), /Old progress|All agents finished/);
	assert.match(plain.join("\n"), /1 needs reply.*1 needs recovery.*1 running/);
});

test("overflow counts distinguish hidden active workers from terminal failures", () => {
	const state = createDefaultTeamState();
	for (let index = 1; index <= 10; index += 1) {
		const workerId = `w${index}`;
		state.activeWorkers[workerId] = makeWorker({ workerId, status: "error", error: "RPC crashed" });
	}
	state.activeWorkers.w11 = makeWorker({ workerId: "w11", status: "running" });
	const text = buildTeamWidgetLines(state).map(stripAnsi).join("\n");
	assert.match(text, /\+ 1 active · 2 need recovery/);
	assert.doesNotMatch(text, /All agents finished/);
});

test("preview aligns elapsed time and sanitizes wide text at wide and narrow widths", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", profileName: "調査担当者".repeat(10), status: "running", startedAt: now - 30_000 });
	state.activeWorkers.w2 = makeWorker({ workerId: "w2", profileName: "fixer", status: "running", startedAt: now - 3_000 });
	state.activeWorkers.w1.lastSummary = {
		workerId: "w1", headline: "Check \x1b]52;c;c2VjcmV0\x07files\n\x1b[2J\x1b[31m状態\x1b[0m\r tail", status: "running", readFiles: [], changedFiles: [], risks: [], relayQuestionCount: 0, updatedAt: now,
	};
	for (const width of [44, 80, 100]) {
		const lines = buildTeamWidgetLines(state, { now, width, theme: makeFakeTheme() });
		const plain = lines.map(stripAnsi);
		assert.ok(!plain.join("\n").includes("\x1b"), "worker controls must be inert while theme colors survive");
		assert.ok(lines.some((line) => line.includes("\x1b[38;5;201m")));
		const rows = plain.filter((line) => /\(w[12]\)/.test(line));
		assert.equal(rows.length, 2, "long profile names must not hide worker ids");
		assert.match(rows[0]!, /30s$/);
		assert.match(rows[1]!, /3s$/);
		for (const row of rows) assert.equal(visibleWidth(row), width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
			assert.doesNotMatch(stripAnsi(line), /[\r\n\t]/);
		}
		if (width < 60) assert.ok(plain.some((line) => line.startsWith("  Check files")), "narrow rows keep the task on a second line");
	}
});

test("active worker elapsed uses task creation time when a reused worker has a fresh task", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		profileName: "fixer",
		status: "running",
		startedAt: now - 60 * 60 * 1_000,
		currentTask: {
			taskId: "t2",
			title: "fresh reused task",
			goal: "validate elapsed display",
			requestedBy: "orchestrator",
			profileName: "fixer",
			cwd: "/repo",
			contextHints: [],
			createdAt: now - 30_000,
		},
	});

	const lines = buildTeamWidgetLines(state, { now, frame: 0 });
	const plainLines = lines.map(stripAnsi);
	const workerRow = plainLines.find((line) => line.includes("fixer (w1)"));
	assert.ok(workerRow, `expected worker row; got:\n${plainLines.join("\n")}`);
	assert.match(workerRow, /fresh reused task\s+30s$/);
	assert.doesNotMatch(workerRow, /1h/);
});

test("widget uses attention order, preserves worker-id order within groups, and filters finished rows", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.w3 = makeWorker({ workerId: "w3", profileName: "closer", status: "completed", lastEventAt: now - 1_000 });
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", profileName: "starter", status: "starting", lastEventAt: now - 2_000 });
	state.activeWorkers.w99 = makeWorker({ workerId: "w99", profileName: "hidden", status: "idle", lastEventAt: now - 10 * 60 * 1_000 });
	state.activeWorkers.w2 = makeWorker({ workerId: "w2", profileName: "runner", status: "running", lastEventAt: now - 3_000 });
	state.activeWorkers.w4 = makeWorker({
		workerId: "w4",
		profileName: "fixer",
		status: "waiting_followup",
		lastEventAt: now - 4_000,
		pendingRelayQuestions: [{
			relayId: "r1",
			workerId: "w4",
			taskId: "t1",
			question: "Need scope decision?",
			assumption: "continue narrowly",
			urgency: "normal",
			createdAt: now - 4_000,
		}],
	});
	state.relayQueue = [state.activeWorkers.w4.pendingRelayQuestions[0]!];

	const lines = buildTeamWidgetLines(state, { frame: 0, now });
	const plainLines = lines.map(stripAnsi);
	assert.match(plainLines.join("\n"), /1 needs reply/);
	const workerRows = plainLines.filter((line) => /^[⠋▸◌✓✗○▶] /.test(line) && / \(w\d+\)/.test(line));
	assert.deepEqual(workerRows.map((line) => line.match(/ \((w\d+)\)/)?.[1]), ["w4", "w1", "w2"]);
	assert.ok(!workerRows.some((line) => line.includes("w99")), `old hidden worker should stay filtered; got:\n${plainLines.join("\n")}`);
	assert.ok(plainLines.some((line) => line.includes("Needs reply")));
	assert.ok(plainLines.some((line) => line.includes("Need scope decision?")), `expected relay detail; got:\n${plainLines.join("\n")}`);
	assert.ok(!plainLines.some((line) => line.includes("└ needs_reply:")), `expected no raw attention key; got:\n${plainLines.join("\n")}`);
});

test("widget treats waiting_followup as live and summarizes old finished workers in its counts", () => {
	const state = createDefaultTeamState();
	const now = 10_000_000;
	state.activeWorkers.oldDone = makeWorker({ workerId: "oldDone", status: "completed", lastEventAt: now - 10 * 60 * 1_000 });
	state.activeWorkers.oldIdle = makeWorker({ workerId: "oldIdle", status: "idle", lastEventAt: now - 10 * 60 * 1_000 });
	state.activeWorkers.queued = makeWorker({ workerId: "queued", status: "waiting_followup", lastEventAt: now - 1_000 });

	const lines = buildTeamWidgetLines(state, { now });
	const plainLines = lines.map(stripAnsi);
	assert.ok(!plainLines.some((line) => line.includes("oldDone") || line.includes("oldIdle")), `old terminal rows should be hidden; got:\n${plainLines.join("\n")}`);
	assert.match(plainLines.join("\n"), /1 done/);
	assert.match(plainLines.join("\n"), /1 idle/);
	assert.ok(plainLines.some((line) => line.includes("▸ 1 queued")), `expected queued count; got:\n${plainLines.join("\n")}`);
	assert.ok(plainLines.some((line) => line.includes("reviewer (queued)")), `waiting_followup worker should render as a live row; got:\n${plainLines.join("\n")}`);
	assert.doesNotMatch(plainLines.join("\n"), /All agents finished|old hidden/);
});

test("widget enforces a hard cap on visible width even with long headlines", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		profileName: "reviewer",
		status: "running",
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "x".repeat(500),
			status: "running",
			readFiles: [],
			changedFiles: [],
			risks: [],
			relayQuestionCount: 0,
			updatedAt: Date.now(),
		},
	});
	const lines = buildTeamWidgetLines(state, { frame: 0 });
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 100, `line exceeds 100 cols (${visibleWidth(line)}): ${line}`);
	}
});

test("widget omits the old static tip line and tips cycle by index", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({ workerId: "w1", profileName: "reviewer", status: "running" });

	const lines = buildTeamWidgetLines(state, { frame: 0 });
	assert.ok(!lines.some((line) => line.includes("tip: /team")), `expected no static widget tip; got:\n${lines.join("\n")}`);
	assert.equal(getTeamStatusTip(0), TEAM_STATUS_TIPS[0]);
	assert.equal(getTeamStatusTip(TEAM_STATUS_TIPS.length), TEAM_STATUS_TIPS[0]);
	assert.equal(getTeamStatusTip(2), "Use /team-copy <id> to copy a worker result");
});

test("hasAnimatedWorkers flips with non-terminal status", () => {
	const state = createDefaultTeamState();
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "idle" });
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w2 = makeWorker({ workerId: "w2", status: "running" });
	assert.equal(hasAnimatedWorkers(state), true);

	state.activeWorkers = { w3: makeWorker({ workerId: "w3", status: "waiting_followup" }) };
	assert.equal(hasAnimatedWorkers(state), true);
});

test("widget shows Σ cost line when displayCost is true", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 2,
			inputTokens: 500,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.0123,
		},
	});
	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true });
	assert.ok(lines.some((line) => line.includes("Σ")), `expected Σ line; got:\n${lines.join("\n")}`);
});

test("widget usage line uses compact token formatter and stays within header width", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 3,
			inputTokens: 999,
			outputTokens: 1_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.0123,
		},
	});
	state.activeWorkers.w2 = makeWorker({
		workerId: "w2",
		status: "running",
		usage: {
			turns: 4,
			inputTokens: 123_456,
			outputTokens: 1_250_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.0456,
		},
	});

	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true });
	const usageLine = lines.find((line) => line.includes("Σ turns=7"));
	assert.ok(usageLine, `expected usage line; got:\n${lines.join("\n")}`);
	assert.match(usageLine, /in=124\.5k/);
	assert.match(usageLine, /out=1\.3m/);
	assert.ok(visibleWidth(usageLine) <= 78, `usage line exceeds 78 cols (${visibleWidth(usageLine)}): ${usageLine}`);
});

test("widget usage line includes cache metrics and aggregate cache hit when width allows", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 2,
			inputTokens: 1_000,
			outputTokens: 2_000,
			cacheReadTokens: 12_345,
			cacheWriteTokens: 600,
			costUsd: 0.1,
		},
	});

	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true });
	const usageLine = lines.find((line) => line.includes("Σ turns=2"));
	assert.ok(usageLine, `expected usage line; got:\n${lines.join("\n")}`);
	assert.match(usageLine, /cache=r12\.3k\/w600 hit=88\.5%/);
	assert.ok(visibleWidth(usageLine) <= 100, `usage line exceeds width (${visibleWidth(usageLine)}): ${usageLine}`);
});

test("widget usage line keeps cache read/write and drops hit percentage first when narrow", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 2,
			inputTokens: 1_000,
			outputTokens: 2_000,
			cacheReadTokens: 12_345,
			cacheWriteTokens: 600,
			costUsd: 0.1,
		},
	});

	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true, width: 60 });
	const usageLine = lines.find((line) => line.includes("Σ turns=2"));
	assert.ok(usageLine, `expected usage line; got:\n${lines.join("\n")}`);
	assert.match(usageLine, /cache=r12\.3k\/w600/);
	assert.doesNotMatch(usageLine, /hit=/);
	assert.ok(visibleWidth(usageLine) <= 60, `usage line exceeds width (${visibleWidth(usageLine)}): ${usageLine}`);
});

test("widget usage line includes retained pruned totals", () => {
	const state = createDefaultTeamState();
	state.prunedWorkerUsageTotals = {
		workers: 1,
		turns: 2,
		inputTokens: 1_000,
		outputTokens: 2_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.1,
		contextTokens: 0,
	};
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 3,
			inputTokens: 999,
			outputTokens: 1_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.2,
		},
	});

	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true });
	const usageLine = lines.find((line) => line.includes("Σ turns=5"));
	assert.ok(usageLine, `expected retained aggregate usage line; got:\n${lines.join("\n")}`);
	assert.match(usageLine, /in=2k/);
	assert.match(usageLine, /out=3k/);
	assert.match(usageLine, /\$0\.3000/);
});

test("widget can show retained-only usage after workers are pruned", () => {
	const state = createDefaultTeamState();
	state.prunedWorkerUsageTotals = {
		workers: 2,
		turns: 7,
		inputTokens: 123_456,
		outputTokens: 50_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.45,
		contextTokens: 0,
	};

	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: true });
	assert.ok(lines.some((line) => line.includes("no workers tracked")), `expected no-workers count line; got:\n${lines.join("\n")}`);
	assert.ok(lines.some((line) => line.includes("Σ") && line.includes("in=123.5k")), `expected retained-only usage line; got:\n${lines.join("\n")}`);
});

test("widget hides retained-only Σ cost line when displayCost is false", () => {
	const state = createDefaultTeamState();
	state.prunedWorkerUsageTotals = {
		workers: 1,
		turns: 1,
		inputTokens: 500,
		outputTokens: 100,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.0123,
		contextTokens: 0,
	};
	assert.deepEqual(buildTeamWidgetLines(state, { frame: 0, displayCost: false }), []);
});

test("widget hides Σ cost line when displayCost is false", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = makeWorker({
		workerId: "w1",
		status: "running",
		usage: {
			turns: 2,
			inputTokens: 500,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.0123,
		},
	});
	const lines = buildTeamWidgetLines(state, { frame: 0, displayCost: false });
	assert.ok(!lines.some((line) => line.includes("Σ")), `expected no Σ line; got:\n${lines.join("\n")}`);
});
