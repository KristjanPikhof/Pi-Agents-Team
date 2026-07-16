import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	CompactPersistenceJournal,
	compactPersistenceRecordPayloadBytes,
	isRecognizedCompactPersistenceRecord,
	markRestoredWorkersExited,
	measureCompactPersistence,
	restorePersistedTeamState,
	restorePersistedTeamStateWithMeasurement,
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

test("canonical writer records are reader-recognized with invalid optional metrics omitted or bounded", () => {
	const state = createDefaultTeamState();
	const terminalWorker = worker("completed");
	terminalWorker.usage.inputTokens = Number.POSITIVE_INFINITY;
	terminalWorker.usage.contextTokens = -1;
	terminalWorker.usage.contextWindow = Number.NaN;
	terminalWorker.usage.contextPercent = Number.MAX_VALUE;
	terminalWorker.usage.contextRemainingTokens = 321;
	state.activeWorkers.w1 = terminalWorker;
	const journal = new CompactPersistenceJournal();
	journal.reset(createDefaultTeamState(), DEFAULT_TEAM_CONFIG);

	const [terminal] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(terminal?.kind, "worker_terminal");
	assert.ok(terminal && isRecognizedCompactPersistenceRecord(terminal));
	if (terminal?.kind !== "worker_terminal") return;
	assert.equal(terminal.worker.usage.inputTokens, 0);
	assert.equal(terminal.worker.usage.contextTokens, undefined);
	assert.equal(terminal.worker.usage.contextWindow, undefined);
	assert.equal(terminal.worker.usage.contextPercent, Number.MAX_SAFE_INTEGER);
	assert.equal(terminal.worker.usage.contextRemainingTokens, 321);

	delete state.activeWorkers.w1;
	const [prune] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(prune?.kind, "worker_pruned");
	assert.ok(prune && isRecognizedCompactPersistenceRecord(prune));
});

test("terminal-to-live transition stages one exited checkpoint and live churn adds no records", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("idle");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);

	state.activeWorkers.w1.status = "running";
	state.activeWorkers.w1.lastSummary!.status = "running";
	const [checkpoint] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(checkpoint?.kind, "worker_terminal");
	if (checkpoint?.kind !== "worker_terminal") return;
	assert.equal(checkpoint.worker.status, "exited");
	assert.equal(checkpoint.worker.lastSummary?.status, "exited");
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), [checkpoint], "append failure retries the checkpoint exactly");

	journal.commit(checkpoint);
	state.activeWorkers.w1.lastToolName = "read";
	state.activeWorkers.w1.finalAnswer = "still streaming";
	state.activeWorkers.w1.lastEventAt += 1;
	state.activeWorkers.w1.usage.inputTokens += 50;
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), [], "ordinary live updates do not churn checkpoints");
});

test("committed detached checkpoints deduplicate unchanged live statuses", () => {
	for (const status of ["starting", "running", "idle", "waiting_followup"] as const) {
		const state = createDefaultTeamState();
		state.activeWorkers.w1 = worker(status);
		const journal = new CompactPersistenceJournal();
		journal.reset(state, DEFAULT_TEAM_CONFIG);

		const [checkpoint] = journal.prepareDetachedWorkers(state, DEFAULT_TEAM_CONFIG);
		assert.equal(checkpoint?.kind, "worker_terminal", `${status}: expected detached checkpoint`);
		if (!checkpoint) continue;
		journal.commit(checkpoint);

		assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), [], `${status}: unchanged prepare must not append`);
		assert.deepEqual(
			journal.prepareDetachedWorkers(state, DEFAULT_TEAM_CONFIG),
			[],
			`${status}: committed durable baseline must deduplicate the next detached checkpoint`,
		);
	}
});

test("a real terminal record supersedes an uncommitted exited checkpoint", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);

	state.activeWorkers.w1.status = "running";
	state.activeWorkers.w1.lastSummary!.status = "running";
	const [checkpoint] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(checkpoint?.kind, "worker_terminal");
	if (checkpoint?.kind !== "worker_terminal") return;
	assert.equal(checkpoint.worker.status, "exited");

	state.activeWorkers.w1.status = "error";
	state.activeWorkers.w1.lastSummary!.status = "error";
	state.activeWorkers.w1.lastSummary!.headline = "real terminal result";
	state.activeWorkers.w1.usage.outputTokens += 10;
	const replacements = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(replacements.length, 1);
	const [terminal] = replacements;
	assert.equal(terminal?.kind, "worker_terminal");
	if (terminal?.kind !== "worker_terminal") return;
	assert.equal(terminal.worker.status, "error");
	assert.equal(terminal.worker.lastSummary?.headline, "real terminal result");
	assert.notEqual(terminal.recordId, checkpoint.recordId);
	journal.commit(terminal);
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), []);
});

test("combined restore inspects candidates once and serializes each recognized record once", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const [record] = new CompactPersistenceJournal().collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(record);

	let candidateInspections = 0;
	const observedRecord = new Proxy(record, {
		getPrototypeOf(target) {
			candidateInspections += 1;
			return Reflect.getPrototypeOf(target);
		},
	});
	let iteratorCalls = 0;
	let yieldedEntries = 0;
	const entries = {
		*[Symbol.iterator]() {
			iteratorCalls += 1;
			yieldedEntries += 1;
			yield entry(observedRecord);
			yieldedEntries += 1;
			yield entry({ version: 2, kind: "worker_terminal", recordId: "malformed", worker: {} });
		},
	};
	const expectedPayloadBytes = compactPersistenceRecordPayloadBytes(record);
	const originalStringify = JSON.stringify;
	let serializations = 0;
	JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
		serializations += 1;
		return originalStringify(...args);
	}) as typeof JSON.stringify;
	try {
		const restored = restorePersistedTeamStateWithMeasurement(
			entries,
			DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
		);
		assert.equal(restored.state.activeWorkers.w1?.status, "completed");
		assert.deepEqual(restored.measurement, {
			recordCount: 1,
			payloadBytes: expectedPayloadBytes,
		});
	} finally {
		JSON.stringify = originalStringify;
	}
	assert.equal(iteratorCalls, 1);
	assert.equal(yieldedEntries, 2);
	assert.equal(candidateInspections, 1);
	assert.equal(serializations, 1);
});

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

test("pending terminal observation updates revision and prune usage to the latest value", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("running");
	const journal = new CompactPersistenceJournal();
	journal.reset(state, DEFAULT_TEAM_CONFIG);
	state.activeWorkers.w1.status = "completed";
	state.activeWorkers.w1.lastSummary!.status = "completed";
	state.activeWorkers.w1.usage.inputTokens = 10;
	const [staleTerminal] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(staleTerminal?.kind, "worker_terminal");

	state.activeWorkers.w1.usage.inputTokens = 999;
	state.activeWorkers.w1.lastSummary!.headline = "latest";
	const [latestTerminal] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(latestTerminal?.kind, "worker_terminal");
	assert.notEqual(latestTerminal?.recordId, staleTerminal?.recordId);
	if (latestTerminal?.kind === "worker_terminal") assert.equal(latestTerminal.worker.usage.inputTokens, 999);

	delete state.activeWorkers.w1;
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), [latestTerminal]);
	journal.commit(latestTerminal!);
	const [prune] = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(prune?.kind, "worker_pruned");
	if (prune?.kind === "worker_pruned") assert.equal(prune.usage.inputTokens, 999);
	journal.commit(prune!);

	const restored = restorePersistedTeamState([entry(latestTerminal), entry(prune)], DEFAULT_TEAM_CONFIG.persistence.stateCustomType);
	assert.equal(restored.prunedWorkerUsageTotals.workers, 1);
	assert.equal(restored.prunedWorkerUsageTotals.inputTokens, 999);
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
	assert.deepEqual(firstJournal.collect(state, config), [], "canonical fitted state does not re-emit forever");
});

test("terminal fitting uses bounded batches rather than one serialization per dropped item", () => {
	const state = createDefaultTeamState();
	const oversized = worker("completed");
	oversized.lastSummary!.headline = "h".repeat(100_000);
	oversized.lastSummary!.readFiles = Array.from({ length: 10_000 }, (_, index) => `${index}-${"r".repeat(1_000)}`);
	oversized.lastSummary!.changedFiles = Array.from({ length: 10_000 }, (_, index) => `${index}-${"c".repeat(1_000)}`);
	oversized.lastSummary!.risks = Array.from({ length: 10_000 }, (_, index) => `${index}-${"x".repeat(1_000)}`);
	state.activeWorkers.w1 = oversized;
	const config = structuredClone(DEFAULT_TEAM_CONFIG);
	config.summaries.maxHeadlineLength = 1_000_000;
	config.summaries.maxItemsPerWorker = 1_000_000;
	config.summaries.maxChangedFiles = 1_000_000;
	let hashes = 0;
	const journal = new CompactPersistenceJournal({
		onRecordHash(kind) {
			if (kind === "terminal") hashes += 1;
		},
	});
	const [record] = journal.collect(state, config);
	assert.ok(record);
	assert.ok(compactPersistenceRecordPayloadBytes(record) <= 16 * 1024);
	assert.ok(hashes < 40, `expected bounded fitting work, observed ${hashes} record hashes`);
});

test("no-op terminal churn performs no record hash and only changed durable workers rehash", () => {
	const state = createDefaultTeamState();
	for (let index = 0; index < 100; index += 1) {
		const current = worker("completed");
		current.workerId = `w${index + 1}`;
		current.profileName = `profile-${index + 1}`;
		current.lastSummary!.workerId = current.workerId;
		state.activeWorkers[current.workerId] = current;
	}
	let hashes = 0;
	const journal = new CompactPersistenceJournal({
		onRecordHash() {
			hashes += 1;
		},
	});
	journal.reset(state, DEFAULT_TEAM_CONFIG);
	hashes = 0;
	for (const current of Object.values(state.activeWorkers)) {
		current.lastEventAt += 1;
		current.lastSummary!.updatedAt += 1;
	}
	assert.deepEqual(journal.prepare(state, DEFAULT_TEAM_CONFIG), []);
	assert.equal(hashes, 0, "retained terminal workers are compared structurally without rehashing");

	state.activeWorkers.w37!.usage.inputTokens += 1;
	const records = journal.prepare(state, DEFAULT_TEAM_CONFIG);
	assert.equal(records.length, 1);
	assert.equal(hashes, 1, "one durable worker revision builds one small record");
});

test("terminal summary timestamp-only refresh is ignored but substantive revision retains its timestamp", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	journal.collect(state, DEFAULT_TEAM_CONFIG);
	state.activeWorkers.w1.lastSummary!.updatedAt = 999;
	assert.deepEqual(journal.collect(state, DEFAULT_TEAM_CONFIG), []);
	state.activeWorkers.w1.lastSummary!.headline = "substantive";
	const [revision] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(revision?.kind, "worker_terminal");
	if (revision?.kind === "worker_terminal") assert.equal(revision.worker.lastSummary?.updatedAt, 999);
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

test("compact replay rejects nonterminal, inconsistent, oversized, and extra-bearing records", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const journal = new CompactPersistenceJournal();
	const [valid] = journal.collect(state, DEFAULT_TEAM_CONFIG);
	assert.equal(valid?.kind, "worker_terminal");
	if (valid?.kind !== "worker_terminal") return;

	const nonterminal = structuredClone(valid);
	nonterminal.worker.status = "running";
	if (nonterminal.worker.lastSummary) nonterminal.worker.lastSummary.status = "running";
	const mismatchedSummary = structuredClone(valid);
	mismatchedSummary.worker.lastSummary!.status = "error";
	const oversizedId = structuredClone(valid);
	oversizedId.worker.workerId = "w".repeat(257);
	const oversizedArray = structuredClone(valid);
	oversizedArray.worker.lastSummary!.readFiles = Array.from({ length: 65 }, () => "a");
	const oversizedPayload = structuredClone(valid);
	oversizedPayload.worker.lastSummary!.risks = Array.from({ length: 64 }, () => "x".repeat(512));
	const extraUsage = {
		...structuredClone(valid),
		worker: {
			...structuredClone(valid.worker),
			usage: { ...valid.worker.usage, attacker: 1 },
		},
	};
	const negativeUsage = structuredClone(valid);
	negativeUsage.worker.usage.inputTokens = -1;

	const restored = restorePersistedTeamState([
		entry(valid),
		entry(nonterminal),
		entry(mismatchedSummary),
		entry(oversizedId),
		entry(oversizedArray),
		entry(oversizedPayload),
		entry(extraUsage),
		entry(negativeUsage),
	], DEFAULT_TEAM_CONFIG.persistence.stateCustomType);
	assert.deepEqual(Object.keys(restored.activeWorkers), ["w1"]);
	assert.equal(restored.activeWorkers.w1?.status, "completed");
	assert.equal(measureCompactPersistence([
		entry(nonterminal),
		entry(mismatchedSummary),
		entry(oversizedId),
		entry(oversizedArray),
		entry(oversizedPayload),
		entry(extraUsage),
		entry(negativeUsage),
	], DEFAULT_TEAM_CONFIG.persistence.stateCustomType).recordCount, 0);
});

test("measurement rejects hostile extras before invoking attacker-controlled serialization", () => {
	const state = createDefaultTeamState();
	state.activeWorkers.w1 = worker("completed");
	const [valid] = new CompactPersistenceJournal().collect(state, DEFAULT_TEAM_CONFIG);
	assert.ok(valid);
	let serialized = false;
	const hostile = {
		...valid,
		extra: {
			toJSON() {
				serialized = true;
				return "x".repeat(10_000_000);
			},
		},
	};
	assert.deepEqual(measureCompactPersistence(
		[entry(hostile)],
		DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
	), { recordCount: 0, payloadBytes: 0 });
	assert.equal(serialized, false);
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
