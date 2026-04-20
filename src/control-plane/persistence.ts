import { createDefaultTeamState, normalizePersistedTeamState, type DEFAULT_TEAM_CONFIG } from "../config";
import type { PersistedTeamState } from "../types";

interface SessionLikeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

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
	reason = "Pi Agent Team session reloaded; relaunch required for live worker control.",
): PersistedTeamState {
	const nextState = normalizePersistedTeamState(state);
	const timestamp = Date.now();

	for (const worker of Object.values(nextState.activeWorkers)) {
		if (["running", "starting", "idle", "waiting_followup"].includes(worker.status)) {
			worker.status = "exited";
			worker.error = reason;
			worker.lastEventAt = timestamp;
			if (worker.lastSummary) {
				worker.lastSummary.status = "exited";
				worker.lastSummary.headline = reason;
				worker.lastSummary.updatedAt = timestamp;
			}
		}
	}

	nextState.updatedAt = timestamp;
	nextState.ui.lastRenderAt = timestamp;
	return nextState;
}

export function createPersistedStateSnapshot(state: PersistedTeamState): PersistedTeamState {
	return normalizePersistedTeamState(state);
}
