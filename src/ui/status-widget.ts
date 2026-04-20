import type { PersistedTeamState } from "../types";

export function buildTeamStatusLine(state: PersistedTeamState): string {
	const workerCount = Object.keys(state.activeWorkers).length;
	const relayCount = state.relayQueue.length;
	return `${state.sessionMode} · workers=${workerCount} · relays=${relayCount}`;
}

export function buildTeamWidgetLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers)
		.sort((left, right) => right.lastEventAt - left.lastEventAt)
		.slice(0, 4);
	const lines = ["Pi Agent Team", buildTeamStatusLine(state)];
	if (workers.length === 0) {
		lines.push("no tracked workers · run /agents to list, /agent-result <id> for output");
		return lines;
	}
	for (const worker of workers) {
		const summary = worker.lastSummary?.headline ? ` · ${worker.lastSummary.headline}` : "";
		lines.push(`[${worker.workerId}] ${worker.profileName}:${worker.status}${summary}`);
	}
	lines.push("tip: /agents · /agent-result <id> · /team");
	return lines;
}
