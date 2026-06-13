import type { Theme } from "@earendil-works/pi-coding-agent";
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
import { themedPalette } from "./theme";
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

export function buildActionSummaryLine(state: PersistedTeamState, theme?: Theme): string {
	const palette = theme ? themedPalette(theme) : undefined;
	const sections = buildRosterSections(state);
	return sections
		.map((section) => (palette ? `${palette.accent(section.label)} ${palette.bold(String(section.workers.length))}` : `${section.label} ${section.workers.length}`))
		.join(" · ");
}

export function buildCompactTeamSummaryLine(state: PersistedTeamState, theme?: Theme): string {
	const palette = theme ? themedPalette(theme) : undefined;
	const workerCount = Object.keys(state.activeWorkers).length;
	const mode = palette ? palette.accent(String(state.sessionMode)) : state.sessionMode;
	const relays = palette ? palette.warning(String(state.relayQueue.length)) : state.relayQueue.length;
	return `workers ${workerCount} · mode ${mode} · relays ${relays} · ${buildActionSummaryLine(state, theme)}`;
}

export function buildTeamDashboardLines(state: PersistedTeamState, theme?: Theme): string[] {
	const palette = theme ? themedPalette(theme) : undefined;
	const workers = Object.values(state.activeWorkers);
	const lines = [
		palette ? palette.accentBold("Pi Agents Team Dashboard") : "Pi Agents Team Dashboard",
		buildCompactTeamSummaryLine(state, theme),
		"/team opens a keyboard-first overlay with the complete worker registry grouped by attention.",
		"Use /team <worker-id> for direct focus, then inspect Workers / Inspect / Console / Cost tabs. Print mode stays summary-only.",
		"Use /team-result <id> for the final deliverable block.",
		"",
	];

	if (workers.length === 0) {
		lines.push(palette ? palette.dim("No tracked workers.") : "No tracked workers.");
		return lines;
	}

	for (const section of buildRosterSections(state)) {
		if (section.workers.length === 0) continue;
		const sectionHeader = palette
			? `${palette.accentBold(section.label)} (${palette.bold(String(section.workers.length))})`
			: `${section.label} (${section.workers.length})`;
		lines.push(sectionHeader);
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

export function buildTeamDashboardText(state: PersistedTeamState, theme?: Theme): string {
	return buildTeamDashboardLines(state, theme).join("\n");
}
