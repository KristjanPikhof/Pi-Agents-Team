import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER_FRAMES, buildTeamStatusLine, buildTeamWidgetLines, hasAnimatedWorkers } from "../../src/ui/status-widget";
import type { WorkerRuntimeState, WorkerStatus } from "../../src/types";

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
	assert.match(statusLine, /workers=0/);
	assert.deepEqual(buildTeamWidgetLines(state), []);
});

test("widget shows spinner frame for running workers and ✓ for finished idle workers", () => {
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
	const w1Frame0 = frame0.find((line) => line.includes("w1 explorer"));
	const w1Frame3 = frame3.find((line) => line.includes("w1 explorer"));
	assert.ok(w1Frame0?.startsWith(`${SPINNER_FRAMES[0]} `));
	assert.ok(w1Frame3?.startsWith(`${SPINNER_FRAMES[3]} `));

	const w2Line = frame0.find((line) => line.includes("w2 librarian"));
	assert.ok(w2Line?.startsWith("✓ "));

	const w3Line = frame0.find((line) => line.includes("w3 fixer"));
	assert.ok(w3Line?.startsWith("✗ "));

	const countsLine = frame0[1]!;
	assert.match(countsLine, /1 running/);
	assert.match(countsLine, /1 done/);
	assert.match(countsLine, /1 ended/);
});

test("widget switches to two-column layout above six workers and caps visible count", () => {
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
	const workerRows = lines.filter((line) => / w\d+ reviewer /.test(line));
	assert.equal(workerRows.length, 8);
	const twoColRows = workerRows.filter((line) => /w\d+ reviewer.*w\d+ reviewer/.test(line));
	assert.ok(twoColRows.length > 0, "expected at least one two-column row");
	assert.ok(lines.some((line) => /\+4 more/.test(line)), "expected spillover marker");

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 78, `line exceeds 78 cols (${visibleWidth(line)}): ${line}`);
	}
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
		assert.ok(visibleWidth(line) <= 78, `line exceeds 78 cols (${visibleWidth(line)}): ${line}`);
	}
});

test("hasAnimatedWorkers flips with non-terminal status", () => {
	const state = createDefaultTeamState();
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "idle" });
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w2 = makeWorker({ workerId: "w2", status: "running" });
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
