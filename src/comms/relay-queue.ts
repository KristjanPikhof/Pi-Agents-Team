import type { RelayQuestion, WorkerRuntimeState } from "../types";

export function collectPendingRelayQuestions(activeWorkers: Record<string, WorkerRuntimeState>): RelayQuestion[] {
	return Object.values(activeWorkers)
		.flatMap((worker) => worker.pendingRelayQuestions)
		.sort((left, right) => left.createdAt - right.createdAt)
		.map((question) => ({ ...question }));
}
