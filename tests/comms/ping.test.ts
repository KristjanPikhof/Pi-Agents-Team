import test from "node:test";
import assert from "node:assert/strict";
import { buildPassivePing, formatPingSnapshot } from "../../src/comms/ping";
import type { WorkerRuntimeState } from "../../src/types";

test("buildPassivePing keeps cached worker status compact", () => {
	const worker: WorkerRuntimeState = {
		workerId: "worker-1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: {
			taskId: "task-1",
			title: "Fix runtime",
			goal: "Repair worker manager",
			requestedBy: "orchestrator",
			profileName: "fixer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		pendingRelayQuestions: [],
		usage: {
			turns: 2,
			inputTokens: 30,
			outputTokens: 11,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.02,
		},
		lastSummary: {
			workerId: "worker-1",
			taskId: "task-1",
			headline: "Worker is ready for follow-up.",
			status: "idle",
			readFiles: [],
			changedFiles: [],
			risks: [],
			relayQuestionCount: 0,
			updatedAt: Date.now(),
		},
	};

	const snapshot = buildPassivePing(worker);
	assert.equal(snapshot.lastSummary, "Worker is ready for follow-up.");
	assert.match(formatPingSnapshot(snapshot), /status=idle/);
	assert.match(formatPingSnapshot(snapshot), /summary=Worker is ready for follow-up/);
});
