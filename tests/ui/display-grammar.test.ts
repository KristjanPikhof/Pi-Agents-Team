import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	WORKER_ATTENTION_ORDER,
	buildWorkerActionHint,
	formatProfileLabel,
	formatWorkerDisplayId,
	formatWorkerLabel,
	formatWorkerStatusLabel,
	formatWorkerToolLabel,
	getWorkerAttentionDisplay,
	getWorkerAttentionPriority,
	getWorkerPrimaryAction,
	getWorkerStatusDisplay,
	getWorkerStatusGlyph,
} from "../../src/ui/display-grammar";
import type { WorkerRuntimeState, WorkerStatus } from "../../src/types";

function makeWorker(overrides: Partial<WorkerRuntimeState> & { status: WorkerStatus } = { status: "running" }): WorkerRuntimeState {
	return {
		workerId: "w1",
		profileName: "fixer",
		sessionMode: "worker",
		status: overrides.status,
		startedAt: 1,
		lastEventAt: 2,
		pendingRelayQuestions: [],
		usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		...overrides,
	};
}

test("worker identity grammar keeps display ids in parentheses and profile fallback in one place", () => {
	assert.equal(formatWorkerDisplayId("w12"), "(w12)");
	assert.equal(formatProfileLabel("fixer"), "fixer");
	assert.equal(formatProfileLabel("   "), "worker");
	assert.equal(formatWorkerLabel(makeWorker({ status: "running", workerId: "w12", profileName: "reviewer" })), "reviewer (w12)");
	assert.equal(formatWorkerToolLabel(makeWorker({ status: "running", workerId: "w12", profileName: "reviewer" })), "w12 (reviewer)");
});

test("status display grammar provides friendly labels and glyphs without changing canonical statuses", () => {
	const running = getWorkerStatusDisplay("running");
	assert.deepEqual(running, { status: "running", label: "Running", glyph: "▶", primaryAction: "Monitor progress" });
	assert.equal(formatWorkerStatusLabel("waiting_followup"), "Waiting for follow-up");
	assert.equal(formatWorkerStatusLabel(makeWorker({ status: "idle", finalAnswer: "headline: done" })), "Done (idle)");
	assert.equal(getWorkerStatusGlyph(makeWorker({ status: "idle" })), "○");
	assert.equal(getWorkerStatusGlyph(makeWorker({ status: "idle", finalAnswer: "headline: done" })), "✓");
	assert.equal(makeWorker({ status: "waiting_followup" }).status, "waiting_followup");
});

test("attention priority and primary action copy are centralized", () => {
	assert.deepEqual(WORKER_ATTENTION_ORDER, ["needs_reply", "needs_recovery", "in_progress", "completed_or_idle"]);
	const relayWorker = makeWorker({
		status: "running",
		pendingRelayQuestions: [{ relayId: "r1", workerId: "w1", taskId: "t1", question: "Need input?", assumption: "Use default", urgency: "high", createdAt: 3 }],
	});
	assert.equal(getWorkerAttentionPriority(relayWorker), "needs_reply");
	assert.equal(getWorkerAttentionDisplay("needs_reply").label, "Needs reply");
	assert.equal(getWorkerPrimaryAction(relayWorker), "Answer relay");
	assert.equal(buildWorkerActionHint(relayWorker), "Needs reply: Answer relay");

	assert.equal(getWorkerAttentionPriority(makeWorker({ status: "error", error: "boom" })), "needs_recovery");
	assert.equal(getWorkerPrimaryAction(makeWorker({ status: "waiting_followup" })), "Send follow-up");
	assert.equal(getWorkerPrimaryAction(makeWorker({ status: "idle", finalAnswer: "done" })), "Review result");
});

test("display grammar strings are visible-width safe primitives for truncation callers", () => {
	const worker = makeWorker({ status: "running", workerId: "w123", profileName: "very-long-profile-name" });
	const values = [
		formatWorkerDisplayId(worker.workerId),
		formatWorkerLabel(worker),
		formatWorkerToolLabel(worker),
		formatWorkerStatusLabel(worker),
		buildWorkerActionHint(worker),
	];
	for (const value of values) {
		assert.equal(visibleWidth(value), value.length, `expected plain ANSI-free grammar string: ${value}`);
		assert.ok(!/[\r\n\t]/.test(value), `expected single-line grammar string: ${value}`);
	}
});
