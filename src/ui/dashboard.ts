import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types";

export type WorkerAttentionGroup = "needs_reply" | "needs_recovery" | "in_progress" | "completed_or_idle";

export interface WorkerRosterSection {
	key: WorkerAttentionGroup;
	label: string;
	workers: WorkerRuntimeState[];
}

const ATTENTION_GROUP_ORDER: WorkerAttentionGroup[] = ["needs_reply", "needs_recovery", "in_progress", "completed_or_idle"];

const ATTENTION_GROUP_LABELS: Record<WorkerAttentionGroup, string> = {
	needs_reply: "Needs reply",
	needs_recovery: "Needs recovery",
	in_progress: "In progress",
	completed_or_idle: "Completed or idle",
};

function sortWorkers(workers: WorkerRuntimeState[]): WorkerRuntimeState[] {
	return workers.slice().sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
}

export function getWorkerAttentionGroup(worker: WorkerRuntimeState): WorkerAttentionGroup {
	if (worker.pendingRelayQuestions.length > 0) return "needs_reply";
	if (worker.error || worker.status === "error" || worker.status === "aborted" || worker.status === "exited") return "needs_recovery";
	if (worker.status === "running" || worker.status === "starting" || worker.status === "waiting_followup") return "in_progress";
	return "completed_or_idle";
}

export function buildWorkerPrioritySnippet(worker: WorkerRuntimeState): string {
	const relay = worker.pendingRelayQuestions[0]?.question?.trim();
	if (relay) return `reply: ${relay}`;
	if (worker.error?.trim()) return `recovery: ${worker.error.trim()}`;
	if (worker.lastSummary?.headline?.trim()) return `headline: ${worker.lastSummary.headline.trim()}`;
	if (worker.currentTask?.title?.trim()) return `task: ${worker.currentTask.title.trim()}`;
	return `status: ${worker.status}`;
}

export function buildRosterSections(state: PersistedTeamState): WorkerRosterSection[] {
	const grouped: Record<WorkerAttentionGroup, WorkerRuntimeState[]> = {
		needs_reply: [],
		needs_recovery: [],
		in_progress: [],
		completed_or_idle: [],
	};

	for (const worker of Object.values(state.activeWorkers)) {
		grouped[getWorkerAttentionGroup(worker)].push(worker);
	}

	return ATTENTION_GROUP_ORDER.map((key) => ({
		key,
		label: ATTENTION_GROUP_LABELS[key],
		workers: sortWorkers(grouped[key]),
	}));
}

export function buildActionSummaryLine(state: PersistedTeamState): string {
	const sections = buildRosterSections(state);
	return sections
		.map((section) => `${section.label} ${section.workers.length}`)
		.join(" · ");
}

export function buildTeamDashboardLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers);
	const lines = [
		"Pi Agents Team Dashboard",
		buildActionSummaryLine(state),
		`Mode ${state.sessionMode} · relay queue ${state.relayQueue.length}`,
		"Use /team for the live queue and /agent-result <id> for deliverables.",
		"",
	];

	if (workers.length === 0) {
		lines.push("No tracked workers.");
		return lines;
	}

	for (const section of buildRosterSections(state)) {
		if (section.workers.length === 0) continue;
		lines.push(`${section.label} (${section.workers.length})`);
		for (const worker of section.workers) {
			lines.push(`- ${worker.workerId} (${worker.profileName}) — ${buildWorkerPrioritySnippet(worker)}`);
			lines.push(`  status: ${worker.status}`);
			if (worker.currentTask?.title) lines.push(`  task: ${worker.currentTask.title}`);
			lines.push(`  usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens}`);
		}
		lines.push("");
	}

	return lines;
}

export function buildTeamDashboardText(state: PersistedTeamState): string {
	return buildTeamDashboardLines(state).join("\n");
}
