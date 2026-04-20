import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { TaskRegistry } from "../../src/control-plane/task-registry";

test("TaskRegistry stores tasks and worker snapshots without transcripts", () => {
	const registry = new TaskRegistry(createDefaultTeamState());
	registry.registerTask({
		taskId: "task-1",
		title: "Review runtime",
		goal: "Inspect the runtime layer",
		requestedBy: "orchestrator",
		profileName: "reviewer",
		cwd: process.cwd(),
		contextHints: ["Focus on edge cases"],
		createdAt: Date.now(),
	});

	registry.upsertWorker({
		workerId: "worker-1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: registry.getTask("task-1"),
		pendingRelayQuestions: [],
		usage: {
			turns: 1,
			inputTokens: 12,
			outputTokens: 7,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		},
		lastSummary: {
			workerId: "worker-1",
			taskId: "task-1",
			headline: "Runtime looks good.",
			status: "idle",
			readFiles: [],
			changedFiles: [],
			risks: [],
			relayQuestionCount: 0,
			updatedAt: Date.now(),
		},
	});

	const snapshot = registry.snapshot();
	assert.equal(Object.keys(snapshot.taskRegistry).length, 1);
	assert.equal(Object.keys(snapshot.activeWorkers).length, 1);
	assert.equal(snapshot.ui.dashboardEntries.length, 1);
	assert.equal(snapshot.activeWorkers["worker-1"]?.lastSummary?.headline, "Runtime looks good.");
});
