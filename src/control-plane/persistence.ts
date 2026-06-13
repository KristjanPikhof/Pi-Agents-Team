import { createDefaultTeamState, normalizePersistedTeamState } from "../config";
import type { PersistedTeamState } from "../types";

interface SessionLikeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface MarkRestoredWorkersExitedResult {
	state: PersistedTeamState;
	markedCount: number;
}

const LIVE_WORKER_STATUSES: readonly string[] = ["running", "starting", "idle", "waiting_followup"];

const REASON_MESSAGE: Record<SessionStartReason, string> = {
	startup: "Pi Agents Team session restored; relaunch required for live worker control.",
	reload: "Pi Agents Team session reloaded; relaunch required for live worker control.",
	resume: "Pi Agents Team session resumed; relaunch required for live worker control.",
	fork: "Pi Agents Team session forked; relaunch required for live worker control.",
	new: "Pi Agents Team new session started; prior workers are no longer attached.",
};

export function restorePersistedTeamState(
	entries: Iterable<SessionLikeEntry>,
	stateCustomType: string,
): PersistedTeamState {
	let latestState: PersistedTeamState | undefined;

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== stateCustomType) continue;
		latestState = normalizePersistedTeamState(entry.data);
	}

	return latestState ?? createDefaultTeamState();
}

export function markRestoredWorkersExited(
	state: PersistedTeamState,
	reasonOrStartReason: string | SessionStartReason = "reload",
): MarkRestoredWorkersExitedResult {
	const nextState = normalizePersistedTeamState(state);
	const timestamp = Date.now();
	const reason =
		reasonOrStartReason in REASON_MESSAGE
			? REASON_MESSAGE[reasonOrStartReason as SessionStartReason]
			: reasonOrStartReason;

	let markedCount = 0;
	for (const worker of Object.values(nextState.activeWorkers)) {
		if (LIVE_WORKER_STATUSES.includes(worker.status)) {
			worker.status = "exited";
			worker.error = reason;
			worker.lastEventAt = timestamp;
			if (worker.lastSummary) {
				worker.lastSummary.status = "exited";
				worker.lastSummary.headline = reason;
				worker.lastSummary.updatedAt = timestamp;
			}
			markedCount += 1;
		}
	}

	nextState.updatedAt = timestamp;
	nextState.ui.lastRenderAt = timestamp;
	return { state: nextState, markedCount };
}

export function createPersistedStateSnapshot(state: PersistedTeamState): PersistedTeamState {
	return normalizePersistedTeamState(state);
}
