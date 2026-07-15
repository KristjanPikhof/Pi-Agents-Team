import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	CompactPersistenceJournal,
	markRestoredWorkersExited,
	restorePersistedTeamState,
} from "../../src/control-plane/persistence";
import type { WorkerRuntimeState } from "../../src/types";

function worker(status: WorkerRuntimeState["status"] = "running"): WorkerRuntimeState {
	return {
		workerId: "w1",
		profileName: "fixer",
		sessionMode: "worker",
		status,
		requestedThinkingLevel: "high",
		effectiveThinkingLevel: "medium",
		processId: 12345,
		startedAt: 10,
		lastEventAt: 20,
		lastToolName: "bash",
		currentTask: {
			taskId: "t1",
			title: "secret title",
			goal: "secret goal",
			requestedBy: "orchestrator",
			profileName: "fixer",
			cwd: "/secret/cwd",
			contextHints: ["secret hint"],
			expectedOutput: "secret output",
			createdAt: 1,
		},
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "done",
			status,
			currentToolName: "bash",
			readFiles: ["a", "b", "c", "d"],
			changedFiles: ["x"],
			risks: ["risk"],
			nextRecommendation: "review",
			relayQuestionCount: 1,
			updatedAt: 20,
		},
		finalAnswer: "secret full final answer",
		pendingRelayQuestions: [{
			relayId: "r1", workerId: "w1", taskId: "t1", question: "secret question",
			assumption: "secret assumption", urgency: "high", createdAt: 2,
		}],
		usage: { turns: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 4, cacheWriteTokens: 3, costUsd: 0.2 },
		error: "secret runtime error",
	};
}

function entry(data: unknown) {
	return { type: "custom", customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType, data };
}

test("compact journal ignores runtime churn and appends one capped allowlisted terminal record", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("running");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);

	state.activeWorkers.w1.lastToolName = "edit";
	state.activeWorkers.w1.finalAnswer = "streaming answer";
	state.activeWorkers.w1.pendingRelayQuestions[0]!.question = "changed relay";
	assert.deepEqual(journal.collect(state, DEFAULT_TEAM_CONFIG), []);

	state.activeWorkers.w1.status = "completed";
	state.activeWorkers.w1.lastSummary!.status = "completed";
	const records = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.kind, "worker_terminal");
	const json = JSON.stringify(records[0]);
	assert.ok(Buffer.byteLength(json, "utf8") <= 16 * 1024);
	for (const secret of ["secret goal", "secret title", "/secret/cwd", "secret question", "streaming answer", "secret runtime error", "bash"]) {
		assert.doesNotMatch(json, new RegExp(secret.replace("/", "\\/")));
	}
	assert.deepEqual(journal.collect(state, DEFAULT_TEAM_CONFIG), [], "duplicate settlement is a no-op");
});

test("v2 replay is deterministic and prune retains usage exactly once", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	journal.reset(createDefaultTeamState(), DEFAULT_TEAM_CONFIG);
	const [terminal] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(terminal);

	delete state.activeWorkers.w1;
	const [prune] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(prune);
	const restored = restorePersistedTeamState(
		[entry(terminal), entry(terminal), entry(prune), entry(prune)],
		DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
	);
	assert.deepEqual(restored.activeWorkers, {});
	assert.equal(restored.prunedWorkerUsageTotals.workers, 1);
	assert.equal(restored.prunedWorkerUsageTotals.inputTokens, 100);
});

test("legacy snapshots remain readable but non-durable payloads are discarded", () => {
	const legacy = createDefaultTeamState();
	legacy.activeWorkers.w1 = worker("completed");
	legacy.taskRegistry.t1 = legacy.activeWorkers.w1.currentTask!;
	legacy.relayQueue = legacy.activeWorkers.w1.pendingRelayQuestions;
	const restored = restorePersistedTeamState([entry(legacy)], DEFAULT_TEAM_CONFIG.persistence.stateCustomType);
	const restoredWorker = restored.activeWorkers.w1!;
	assert.equal(restoredWorker.status, "completed");
	assert.equal(restoredWorker.lastSummary?.headline, "done");
	assert.equal(restoredWorker.usage.inputTokens, 100);
	assert.equal(restoredWorker.finalAnswer, undefined);
	assert.equal(restoredWorker.currentTask, undefined);
	assert.equal(restoredWorker.processId, undefined);
	assert.equal(restoredWorker.lastToolName, undefined);
	assert.equal(restoredWorker.error, undefined);
	assert.deepEqual(restoredWorker.pendingRelayQuestions, []);
	assert.deepEqual(restored.taskRegistry, {});
	assert.deepEqual(restored.relayQueue, []);
});

test("markRestoredWorkersExited converts live workers and maps branch reasons", () => {
	const base = createDefaultTeamState();
	base.activeWorkers.w1 = worker("running");
	const { state: resumed, markedCount } = markRestoredWorkersExited(base, "resume");
	assert.equal(markedCount, 1);
	assert.equal(resumed.activeWorkers.w1?.status, "exited");
	assert.match(resumed.activeWorkers.w1?.error ?? "", /resumed/);

	const forkBase = createDefaultTeamState();
	forkBase.activeWorkers.w1 = worker("running");
	const forked = markRestoredWorkersExited(forkBase, "fork");
	assert.match(forked.state.activeWorkers.w1?.error ?? "", /forked/);
});
