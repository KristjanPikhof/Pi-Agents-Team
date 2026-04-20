import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
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

test("status widget renders counts and a compact tip line", () => {
	const state = createDefaultTeamState();
	state.relayQueue.push({
		relayId: "relay-1",
		workerId: "w1",
		taskId: "t1",
		question: "Need direction?",
		assumption: "Stay passive",
		urgency: "medium",
		createdAt: Date.now(),
	});
	const statusLine = buildTeamStatusLine(state);
	assert.match(statusLine, /relays=1/);

	const lines = buildTeamWidgetLines(state);
	assert.equal(lines[0], "Pi Agent Team");
	assert.match(lines[1]!, /1 relay/);
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

test("hasAnimatedWorkers flips with non-terminal status", () => {
	const state = createDefaultTeamState();
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w1 = makeWorker({ workerId: "w1", status: "idle" });
	assert.equal(hasAnimatedWorkers(state), false);

	state.activeWorkers.w2 = makeWorker({ workerId: "w2", status: "running" });
	assert.equal(hasAnimatedWorkers(state), true);
});
