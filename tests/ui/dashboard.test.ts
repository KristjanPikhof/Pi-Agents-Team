import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { buildTeamDashboardText } from "../../src/ui/dashboard";

test("buildTeamDashboardText summarizes workers, relays, and usage", () => {
	const state = createDefaultTeamState();
	state.activeWorkers["worker-1"] = {
		workerId: "worker-1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "running",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: {
			taskId: "task-1",
			title: "Review UI",
			goal: "Inspect operator commands",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: Date.now(),
		},
		pendingRelayQuestions: [],
		usage: {
			turns: 2,
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.02,
		},
		lastSummary: {
			workerId: "worker-1",
			taskId: "task-1",
			headline: "UI review in progress",
			status: "running",
			readFiles: [],
			changedFiles: [],
			risks: [],
			relayQuestionCount: 0,
			updatedAt: Date.now(),
		},
	};
	const text = buildTeamDashboardText(state);
	assert.match(text, /Pi Agents Team Dashboard/);
	assert.match(text, /worker-1/);
	assert.match(text, /UI review in progress/);
});
