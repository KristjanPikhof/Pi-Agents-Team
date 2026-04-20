import { buildDashboardEntries, createDefaultTeamState, normalizePersistedTeamState } from "../config";
import { collectPendingRelayQuestions } from "../comms/relay-queue";
import type { DelegatedTaskInput, PersistedTeamState, WorkerRuntimeState } from "../types";

export class TaskRegistry {
	private state: PersistedTeamState;

	constructor(initialState?: PersistedTeamState) {
		this.state = normalizePersistedTeamState(initialState ?? createDefaultTeamState());
		this.refreshDerivedState();
	}

	restore(nextState: PersistedTeamState): void {
		this.state = normalizePersistedTeamState(nextState);
		this.refreshDerivedState();
	}

	registerTask(task: DelegatedTaskInput): void {
		this.state.taskRegistry[task.taskId] = { ...task };
		this.touch();
	}

	upsertWorker(worker: WorkerRuntimeState): void {
		this.state.activeWorkers[worker.workerId] = structuredClone(worker);
		this.touch();
	}

	markWorkerExited(workerId: string, reason: string): WorkerRuntimeState | undefined {
		const worker = this.state.activeWorkers[workerId];
		if (!worker) return undefined;
		worker.status = "exited";
		worker.error = reason;
		worker.lastEventAt = Date.now();
		if (worker.lastSummary) {
			worker.lastSummary.status = "exited";
			worker.lastSummary.headline = reason;
			worker.lastSummary.updatedAt = worker.lastEventAt;
		}
		this.touch();
		return structuredClone(worker);
	}

	listWorkers(): WorkerRuntimeState[] {
		return Object.values(this.state.activeWorkers)
			.sort((left, right) => right.lastEventAt - left.lastEventAt)
			.map((worker) => structuredClone(worker));
	}

	getWorker(workerId: string): WorkerRuntimeState | undefined {
		const worker = this.state.activeWorkers[workerId];
		return worker ? structuredClone(worker) : undefined;
	}

	getTask(taskId: string): DelegatedTaskInput | undefined {
		const task = this.state.taskRegistry[taskId];
		return task ? { ...task } : undefined;
	}

	snapshot(): PersistedTeamState {
		this.refreshDerivedState();
		return structuredClone(this.state);
	}

	private touch(): void {
		this.state.updatedAt = Date.now();
		this.refreshDerivedState();
	}

	private refreshDerivedState(): void {
		this.state.ui.dashboardEntries = buildDashboardEntries(this.state.activeWorkers);
		this.state.ui.lastRenderAt = Date.now();
		this.state.relayQueue = collectPendingRelayQuestions(this.state.activeWorkers);
	}
}
