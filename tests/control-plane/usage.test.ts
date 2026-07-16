import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState, normalizePersistedTeamState } from "../../src/config";
import { addWorkerUsageToAggregate, aggregateWorkerUsage, createZeroWorkerUsageAggregate, hasWorkerUsage } from "../../src/usage";
import type { WorkerRuntimeState } from "../../src/types";

function worker(workerId: string, usage: WorkerRuntimeState["usage"]): WorkerRuntimeState {
	return {
		workerId,
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		requestedThinkingLevel: "medium",
		effectiveThinkingLevel: "medium",
		startedAt: 1,
		lastEventAt: 1,
		pendingRelayQuestions: [],
		usage,
	};
}

test("createDefaultTeamState includes zero pruned usage totals", () => {
	assert.deepEqual(createDefaultTeamState().prunedWorkerUsageTotals, createZeroWorkerUsageAggregate());
});

test("normalizePersistedTeamState fills missing and partial pruned usage totals", () => {
	const legacy = normalizePersistedTeamState({ activeWorkers: {}, taskRegistry: {}, relayQueue: [], ui: {} });
	assert.deepEqual(legacy.prunedWorkerUsageTotals, createZeroWorkerUsageAggregate());

	const partial = normalizePersistedTeamState({
		activeWorkers: {},
		prunedWorkerUsageTotals: { workers: 2, inputTokens: 100, costUsd: 0.5 },
		taskRegistry: {},
		relayQueue: [],
		ui: {},
	});
	assert.deepEqual(partial.prunedWorkerUsageTotals, {
		workers: 2,
		turns: 0,
		inputTokens: 100,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.5,
		contextTokens: 0,
	});
});

test("hasWorkerUsage treats cache-only aggregates as visible usage", () => {
	assert.equal(hasWorkerUsage(createZeroWorkerUsageAggregate()), false);
	assert.equal(hasWorkerUsage({ ...createZeroWorkerUsageAggregate(), cacheReadTokens: 42 }), true);
	assert.equal(hasWorkerUsage({ ...createZeroWorkerUsageAggregate(), cacheWriteTokens: 7 }), true);
});

test("usage helpers preserve authoritative fractional costs instead of deriving them from counters", () => {
	const retained = createZeroWorkerUsageAggregate();
	const tiered = worker("worker-tiered", {
		turns: 1,
		inputTokens: 800_001,
		outputTokens: 12_345,
		cacheReadTokens: 654_321,
		cacheWriteTokens: 9_876,
		costUsd: 0.01987654321,
	});
	const tiny = worker("worker-tiny", {
		turns: 1,
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.00765432109,
	});

	const tieredOnly = addWorkerUsageToAggregate(retained, tiered.usage);
	const aggregate = aggregateWorkerUsage([tiered, tiny], retained);

	assert.equal(tieredOnly.costUsd, 0.01987654321);
	assert.equal(aggregate.inputTokens, 800_002);
	assert.equal(aggregate.costUsd, 0.0275308643);
});

test("usage helpers add active workers to retained totals without mutating inputs", () => {
	const retained = {
		workers: 1,
		turns: 2,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 25,
		cacheWriteTokens: 5,
		costUsd: 0.25,
		contextTokens: 80,
	};
	const activeWorker = worker("worker-1", {
		turns: 3,
		inputTokens: 200,
		outputTokens: 75,
		cacheReadTokens: 10,
		cacheWriteTokens: 2,
		costUsd: 0.4,
		contextTokens: 60,
	});

	const added = addWorkerUsageToAggregate(retained, activeWorker.usage);
	const aggregated = aggregateWorkerUsage([activeWorker], retained);

	assert.deepEqual(retained, {
		workers: 1,
		turns: 2,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 25,
		cacheWriteTokens: 5,
		costUsd: 0.25,
		contextTokens: 80,
	});
	assert.deepEqual(added, {
		workers: 2,
		turns: 5,
		inputTokens: 300,
		outputTokens: 125,
		cacheReadTokens: 35,
		cacheWriteTokens: 7,
		costUsd: 0.65,
		contextTokens: 140,
	});
	assert.deepEqual(aggregated, added);
});
