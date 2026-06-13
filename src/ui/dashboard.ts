import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types";
import {
	WORKER_ATTENTION_ORDER,
	formatWorkerLabel,
	formatWorkerStatusLabel,
	getWorkerAttentionDisplay,
	getWorkerAttentionPriority as getSharedWorkerAttentionPriority,
	getWorkerPrimaryAction,
	type WorkerAttentionPriority,
} from "./display-grammar";
import { formatCompactTokenCount } from "./usage-format";

export type WorkerAttentionGroup = WorkerAttentionPriority;

export interface WorkerRosterSection {
	key: WorkerAttentionGroup;
	label: string;
	workers: WorkerRuntimeState[];
}

function sortWorkers(workers: WorkerRuntimeState[]): WorkerRuntimeState[] {
	return workers.slice().sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
}

export function getWorkerAttentionGroup(worker: WorkerRuntimeState): WorkerAttentionGroup {
	return getSharedWorkerAttentionPriority(worker);
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

	return WORKER_ATTENTION_ORDER.map((key) => ({
		key,
		label: getWorkerAttentionDisplay(key).label,
		workers: sortWorkers(grouped[key]),
	}));
}

export function buildActionSummaryLine(state: PersistedTeamState): string {
	const sections = buildRosterSections(state);
	return sections
		.map((section) => `${section.label} ${section.workers.length}`)
		.join(" · ");
}

export function buildCompactTeamSummaryLine(state: PersistedTeamState): string {
	const workerCount = Object.keys(state.activeWorkers).length;
	return `workers ${workerCount} · mode ${state.sessionMode} · relays ${state.relayQueue.length} · ${buildActionSummaryLine(state)}`;
}

export function buildTeamDashboardLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers);
	const lines = [
		"Pi Agents Team Dashboard",
		buildCompactTeamSummaryLine(state),
		"/team opens a keyboard-first overlay with the complete worker registry grouped by attention.",
		"Use /team <worker-id> for direct focus, then inspect Workers / Inspect / Console / Cost tabs. Print mode stays summary-only.",
		"Use /team-result <id> for the final deliverable block.",
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
			lines.push(`- ${formatWorkerLabel(worker)} — ${buildWorkerPrioritySnippet(worker)}`);
			lines.push(`  status: ${worker.status} (${formatWorkerStatusLabel(worker)}) · action: ${getWorkerPrimaryAction(worker)}`);
			if (worker.currentTask?.title) lines.push(`  task: ${worker.currentTask.title}`);
			lines.push(
				`  usage: turns=${worker.usage.turns} input=${formatCompactTokenCount(worker.usage.inputTokens)} output=${formatCompactTokenCount(worker.usage.outputTokens)}`,
			);
		}
		lines.push("");
	}

	return lines;
}

export function buildTeamDashboardText(state: PersistedTeamState): string {
	return buildTeamDashboardLines(state).join("\n");
}
