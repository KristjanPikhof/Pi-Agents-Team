import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	CompactPersistenceJournal,
	compactPersistenceRecordPayloadBytes,
	markRestoredWorkersExited,
	measureCompactPersistence,
	restorePersistedTeamState,
} from "../../src/control-plane/persistence";
import type { TeamPersistenceRecord, WorkerRuntimeState } from "../../src/types";

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
	state.activeWorkers.w1.lastEventAt += 1;
	assert.deepEqual(journal.collect(state, DEFAULT_TEAM_CONFIG), [], "terminal activity timestamp churn is not durable");
	state.activeWorkers.w1.usage.inputTokens = 999;
	const [usageRevision] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(usageRevision?.kind, "worker_terminal", "terminal usage revisions are durable");
	state.activeWorkers.w1.lastSummary!.headline = "revised result";
	const [summaryRevision] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(summaryRevision?.kind, "worker_terminal", "terminal summary revisions are durable");
});

test("prepare requires append commit and retries an uncommitted transition exactly", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("running");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);
	state.activeWorkers.w1.status = "completed";
	state.activeWorkers.w1.lastSummary!.status = "completed";
	const [first] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.ok(first);
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), [first], "failed append remains pending");
	journal.commit(first);
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), []);
});

test("Unicode-heavy records are deterministically UTF-8 bounded without split surrogates", () => {
	const state = createDefaultTeamState();
	const unicodeWorker = worker("completed");
	unicodeWorker.lastSummary!.headline = "😀".repeat(10_000);
	unicodeWorker.lastSummary!.readFiles = Array.from({ length: 200 }, (_, index) => `${index}-${"界".repeat(1_000)}`);
	unicodeWorker.lastSummary!.changedFiles = [...unicodeWorker.lastSummary!.readFiles];
	unicodeWorker.lastSummary!.risks = [...unicodeWorker.lastSummary!.readFiles];
	state.activeWorkers.w1 = unicodeWorker;
	const config = structuredClone(DEFAULT_TEAM_CONFIG);
	config.summaries.maxHeadlineLength = 100_000;
	config.summaries.maxItemsPerWorker = 1_000;
	config.summaries.maxChangedFiles = 1_000;
	const firstJournal = new CompactPersistenceJournal();
	const secondJournal = new CompactPersistenceJournal();
	const [first] = firstJournal.collect(state, config);
	const [second] = secondJournal.collect(state, config);
	assert.deepEqual(first, second);
	assert.ok(first);
	assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 16 * 1024);
	assert.doesNotMatch(JSON.stringify(first), /�/);
});

test("10,000 non-durable mutations add no measured growth; durable transitions do", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("running");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);
	const records: TeamPersistenceRecord[] = [];
	for (let index = 0; index < 10_000; index += 1) {
		state.activeWorkers.w1.lastToolName = `tool-${index}`;
		state.activeWorkers.w1.finalAnswer = `stream-${index}`;
		state.activeWorkers.w1.lastEventAt += 1;
		records.push(...journal.collect(state, DEFAULT_TEAM_CONFIG));
	}
	assert.deepEqual(records, []);
	assert.deepEqual(measureCompactPersistence(records.map(entry), DEFAULT_TEAM_CONFIG.persistence.stateCustomType), {
		recordCount: 0,
		payloadBytes: 0,
	});

	state.activeWorkers.w1.status = "completed";
	state.activeWorkers.w1.lastSummary!.status = "completed";
	records.push(...journal.collect(state, DEFAULT_TEAM_CONFIG));
	state.activeWorkers.w1.lastSummary!.headline = "durable revision";
	records.push(...journal.collect(state, DEFAULT_TEAM_CONFIG));
	delete state.activeWorkers.w1;
	records.push(...journal.collect(state, DEFAULT_TEAM_CONFIG));
	const measurement = measureCompactPersistence(records.map(entry), DEFAULT_TEAM_CONFIG.persistence.stateCustomType);
	assert.equal(measurement.recordCount, 3);
	assert.equal(measurement.payloadBytes, records.reduce((sum, record) => sum + compactPersistenceRecordPayloadBytes(record), 0));
});

test("compact measurement counts only recognized current-version records on the selected branch", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	const [record] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(record);
	const branch = [
		entry(record),
		entry(record),
		entry({ version: 999, kind: "worker_terminal", recordId: "future", worker: record.kind === "worker_terminal" ? record.worker : {} }),
		entry({ version: 2, kind: "worker_terminal", recordId: "malformed", worker: {} }),
		{ type: "custom", customType: "other", data: record },
	];
	assert.deepEqual(measureCompactPersistence(branch, DEFAULT_TEAM_CONFIG.persistence.stateCustomType), {
		recordCount: 2,
		payloadBytes: 2 * compactPersistenceRecordPayloadBytes(record),
	});
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

test("malformed and future same-type records do not reset valid replay state", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	const [terminal] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(terminal);
	const restored = restorePersistedTeamState([
		entry(terminal),
		entry({ version: 2, kind: "worker_terminal", recordId: "bad", worker: { workerId: 7 } }),
		entry({ version: 999, kind: "worker_terminal", recordId: "future", worker: {} }),
		entry({ version: 2, kind: "unexpected", recordId: "unknown" }),
	], DEFAULT_TEAM_CONFIG.persistence.stateCustomType);
	assert.equal(restored.activeWorkers.w1?.lastSummary?.headline, "done");
});

test("markRestoredWorkersExited detaches live workers without overwriting their saved summary", () => {
	const base = createDefaultTeamState();
	base.activeWorkers.w1 = worker("idle");
	const savedSummary = structuredClone(base.activeWorkers.w1.lastSummary);
	const { state: resumed, markedCount } = markRestoredWorkersExited(base, "resume");
	assert.equal(markedCount, 1);
	assert.equal(resumed.activeWorkers.w1?.status, "exited");
	assert.match(resumed.activeWorkers.w1?.error ?? "", /resumed/);
	assert.deepEqual(resumed.activeWorkers.w1?.lastSummary, savedSummary);

	const forkBase = createDefaultTeamState();
	forkBase.activeWorkers.w1 = worker("running");
	const forked = markRestoredWorkersExited(forkBase, "fork");
	assert.match(forked.state.activeWorkers.w1?.error ?? "", /forked/);
});
