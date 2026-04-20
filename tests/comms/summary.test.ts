import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerSummaryFromText, extractRelayQuestions } from "../../src/comms/summary";
import type { WorkerRuntimeState } from "../../src/types";

function createWorker(status: WorkerRuntimeState["status"] = "idle"): WorkerRuntimeState {
	return {
		workerId: "worker-1",
		profileName: "reviewer",
		sessionMode: "worker",
		status,
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: {
			taskId: "task-1",
			title: "Review comms",
			goal: "Inspect relay flows",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};
}

test("buildWorkerSummaryFromText extracts compact fields", () => {
	const worker = createWorker();
	const summary = buildWorkerSummaryFromText(
		[
			"headline: Ping flow is stable",
			"read_files:",
			"- src/comms/ping.ts",
			"changed_files:",
			"- src/comms/summary.ts",
			"risks:",
			"- Active ping still depends on fresh RPC state",
			"next_recommendation: add a UI surface for relay questions",
		].join("\n"),
		worker,
	);

	assert.equal(summary.headline, "Ping flow is stable");
	assert.deepEqual(summary.readFiles, ["src/comms/ping.ts"]);
	assert.deepEqual(summary.changedFiles, ["src/comms/summary.ts"]);
	assert.equal(summary.nextRecommendation, "add a UI surface for relay questions");
});

test("extractRelayQuestions ignores placeholder values like 'none' or 'n/a'", () => {
	const worker = createWorker("idle");
	for (const placeholder of ["none", "None.", "N/A", "no", "nope", "-", "—", "no question", "not needed"]) {
		const relays = extractRelayQuestions(`relay_question: ${placeholder}\nassumption: whatever`, worker);
		assert.equal(relays.length, 0, `expected no relay for placeholder "${placeholder}"`);
	}

	const realRelay = extractRelayQuestions(
		"relay_question: Should I keep going?\nassumption: yes",
		worker,
	);
	assert.equal(realRelay.length, 1);
});

test("extractRelayQuestions parses ask-orchestrator style output", () => {
	const worker = createWorker("running");
	const relays = extractRelayQuestions(
		[
			"relay_question: Should I keep passive ping only or add an active refresh too?",
			"assumption: I will keep passive ping as the default.",
			"urgency: high",
			"choices:",
			"- passive only",
			"- passive plus active",
		].join("\n"),
		worker,
	);

	assert.equal(relays.length, 1);
	assert.equal(relays[0]?.urgency, "high");
	assert.match(relays[0]?.assumption ?? "", /passive ping/);
	assert.deepEqual(relays[0]?.choices, ["passive only", "passive plus active"]);
});
