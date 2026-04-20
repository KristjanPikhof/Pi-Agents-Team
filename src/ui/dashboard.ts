import { compareWorkerIds, type PersistedTeamState } from "../types";

export function buildTeamDashboardLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers).sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
	const lines = [
		"Pi Agent Team Dashboard",
		`mode: ${state.sessionMode}`,
		`workers: ${workers.length}`,
		`relay questions: ${state.relayQueue.length}`,
		"",
	];

	if (workers.length === 0) {
		lines.push("No tracked workers.");
		return lines;
	}

	for (const worker of workers) {
		lines.push(`${worker.workerId} (${worker.profileName})`);
		lines.push(`  status: ${worker.status}`);
		if (worker.currentTask?.title) lines.push(`  task: ${worker.currentTask.title}`);
		if (worker.lastToolName) lines.push(`  tool: ${worker.lastToolName}`);
		if (worker.lastSummary?.headline) lines.push(`  summary: ${worker.lastSummary.headline}`);
		if (worker.pendingRelayQuestions.length > 0) {
			lines.push(`  relays: ${worker.pendingRelayQuestions.length}`);
		}
		lines.push(`  usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens}`);
		lines.push("");
	}

	return lines;
}

export function buildTeamDashboardText(state: PersistedTeamState): string {
	return buildTeamDashboardLines(state).join("\n");
}
