import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { buildTeamDashboardText } from "../../src/ui/dashboard";

test("buildTeamDashboardText groups workers by operator attention and surfaces prioritized snippets", () => {
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
		pendingRelayQuestions: [{
			relayId: "relay-1",
			workerId: "worker-1",
			taskId: "task-1",
			question: "Need operator confirmation",
			assumption: "wait",
			urgency: "high",
			createdAt: Date.now(),
		}],
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
			relayQuestionCount: 1,
			updatedAt: Date.now(),
		},
	};
	state.activeWorkers["worker-2"] = {
		workerId: "worker-2",
		profileName: "fixer",
		sessionMode: "worker",
		status: "error",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 1,
			inputTokens: 5,
			outputTokens: 3,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		},
		error: "RPC crashed",
	};
	state.activeWorkers["worker-3"] = {
		workerId: "worker-3",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 3,
			inputTokens: 12,
			outputTokens: 6,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.03,
		},
		finalAnswer: "headline: done",
		lastSummary: {
			workerId: "worker-3",
			taskId: "task-3",
			headline: "Ship list is ready",
			status: "idle",
			readFiles: [],
			changedFiles: [],
			risks: [],
			relayQuestionCount: 0,
			updatedAt: Date.now(),
		},
	};
	const text = buildTeamDashboardText(state);
	assert.match(text, /Pi Agents Team Dashboard/);
	assert.match(text, /Needs reply 1 · Needs recovery 1 · In progress 0 · Completed or idle 1/);
	assert.match(text, /keyboard-first overlay: queue on the left, inspector on the right when width allows/);
	assert.match(text, /Use \/team <worker-id> for direct focus, then inspect Overview \/ Deliverable \/ Console tabs/);
	assert.match(text, /Use \/agent-result <id> for the final deliverable block/);
	assert.match(text, /Needs reply \(1\)/);
	assert.match(text, /worker-1 \(reviewer\) — reply: Need operator confirmation/);
	assert.match(text, /Needs recovery \(1\)/);
	assert.match(text, /worker-2 \(fixer\) — recovery: RPC crashed/);
	assert.match(text, /Completed or idle \(1\)/);
	assert.match(text, /worker-3 \(reviewer\) — headline: Ship list is ready/);
});

test("buildTeamDashboardText keeps print fallback useful when no workers are tracked", () => {
	const state = createDefaultTeamState();
	const text = buildTeamDashboardText(state);
	assert.match(text, /Pi Agents Team Dashboard/);
	assert.match(text, /Print mode stays summary-only/);
	assert.match(text, /No tracked workers\./);
});
