import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types.js";
import {
	WORKER_ATTENTION_ORDER,
	formatWorkerLabel,
	formatWorkerStatusLabel,
	getWorkerAttentionDisplay,
	getWorkerAttentionPriority as getSharedWorkerAttentionPriority,
	getWorkerPrimaryAction,
	type WorkerAttentionPriority,
} from "./display-grammar.js";
import { themedPalette } from "./theme.js";
import { formatCompactTokenCount } from "./usage-format.js";

export type WorkerAttentionGroup = WorkerAttentionPriority;

export interface WorkerRosterSection {
	key: WorkerAttentionGroup;
	label: string;
	workers: WorkerRuntimeState[];
}

const DEFAULT_DASHBOARD_WIDTH = 160;

export interface TeamDashboardTextOptions {
	theme?: Theme;
	width?: number;
	displayCost?: boolean;
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

export function buildTeamDashboardLines(
	state: PersistedTeamState,
	themeOrOptions?: Theme | TeamDashboardTextOptions,
	width = DEFAULT_DASHBOARD_WIDTH,
): string[] {
	const options = themeOrOptions && ("displayCost" in themeOrOptions || "theme" in themeOrOptions || "width" in themeOrOptions)
		? themeOrOptions as TeamDashboardTextOptions
		: { theme: themeOrOptions as Theme | undefined, width };
	const theme = options.theme;
	const resolvedWidth = options.width ?? width;
	const displayCost = options.displayCost !== false;
	const palette = theme ? themedPalette(theme) : undefined;
	const workers = Object.values(state.activeWorkers);
	const tabSummary = displayCost ? "Workers / Inspect / Console / Cost" : "Workers / Inspect / Console";
	const lines = [
		truncateToWidth(palette ? palette.accentBold("Pi Agents Team Dashboard") : "Pi Agents Team Dashboard", resolvedWidth),
		truncateToWidth(buildCompactTeamSummaryLine(state, theme), resolvedWidth),
		truncateToWidth("/team opens a keyboard-first overlay with the complete worker registry grouped by attention.", resolvedWidth),
		truncateToWidth(`Use /team <worker-id> for direct focus, then inspect ${tabSummary} tabs. Print mode stays summary-only.`, resolvedWidth),
		truncateToWidth("Use /team-result <id> for the final deliverable block.", resolvedWidth),
		"",
	];

	if (workers.length === 0) {
		lines.push(truncateToWidth(palette ? palette.dim("No tracked workers.") : "No tracked workers.", resolvedWidth));
		return lines;
	}

	for (const section of buildRosterSections(state)) {
		if (section.workers.length === 0) continue;
		const sectionHeader = palette
			? `${palette.accentBold(section.label)} (${palette.bold(String(section.workers.length))})`
			: `${section.label} (${section.workers.length})`;
		lines.push(truncateToWidth(sectionHeader, resolvedWidth));
		for (const worker of section.workers) {
			lines.push(truncateToWidth(`- ${formatWorkerLabel(worker)} — ${buildWorkerPrioritySnippet(worker)}`, resolvedWidth, "…"));
			lines.push(
				truncateToWidth(`  status: ${worker.status} (${formatWorkerStatusLabel(worker)}) · action: ${getWorkerPrimaryAction(worker)}`, resolvedWidth, "…"),
			);
			if (worker.currentTask?.title) lines.push(truncateToWidth(`  task: ${worker.currentTask.title}`, resolvedWidth, "…"));
			lines.push(
				truncateToWidth(
					`  usage: turns=${worker.usage.turns} input=${formatCompactTokenCount(worker.usage.inputTokens)} output=${formatCompactTokenCount(worker.usage.outputTokens)}`,
					resolvedWidth,
					"…",
				),
			);
		}
		lines.push("");
	}

	return lines;
}

export function buildTeamDashboardText(
	state: PersistedTeamState,
	themeOrOptions?: Theme | TeamDashboardTextOptions,
	width = DEFAULT_DASHBOARD_WIDTH,
): string {
	return buildTeamDashboardLines(state, themeOrOptions, width).join("\n");
}
