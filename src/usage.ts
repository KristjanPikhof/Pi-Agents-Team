import type { WorkerRuntimeState, WorkerUsageAggregate, WorkerUsageStats } from "./types";

function numericField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createZeroWorkerUsageAggregate(): WorkerUsageAggregate {
	return {
		workers: 0,
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		contextTokens: 0,
	};
}

export function normalizeWorkerUsageAggregate(value: unknown): WorkerUsageAggregate {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return createZeroWorkerUsageAggregate();
	}
	const record = value as Record<string, unknown>;
	return {
		workers: numericField(record.workers),
		turns: numericField(record.turns),
		inputTokens: numericField(record.inputTokens),
		outputTokens: numericField(record.outputTokens),
		cacheReadTokens: numericField(record.cacheReadTokens),
		cacheWriteTokens: numericField(record.cacheWriteTokens),
		costUsd: numericField(record.costUsd),
		contextTokens: numericField(record.contextTokens),
	};
}

export function addWorkerUsageToAggregate(
	aggregate: WorkerUsageAggregate,
	usage: WorkerUsageStats,
	workerCount = 1,
): WorkerUsageAggregate {
	return {
		workers: aggregate.workers + workerCount,
		turns: aggregate.turns + usage.turns,
		inputTokens: aggregate.inputTokens + usage.inputTokens,
		outputTokens: aggregate.outputTokens + usage.outputTokens,
		cacheReadTokens: aggregate.cacheReadTokens + usage.cacheReadTokens,
		cacheWriteTokens: aggregate.cacheWriteTokens + usage.cacheWriteTokens,
		costUsd: aggregate.costUsd + usage.costUsd,
		contextTokens: aggregate.contextTokens + (usage.contextTokens ?? 0),
	};
}

export function aggregateWorkerUsage(
	activeWorkers: Iterable<WorkerRuntimeState>,
	retainedUsage: WorkerUsageAggregate = createZeroWorkerUsageAggregate(),
): WorkerUsageAggregate {
	let aggregate = { ...retainedUsage };
	for (const worker of activeWorkers) {
		aggregate = addWorkerUsageToAggregate(aggregate, worker.usage);
	}
	return aggregate;
}
