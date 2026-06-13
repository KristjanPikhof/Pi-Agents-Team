import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage";
import { formatProfileLabel, formatWorkerDisplayId, formatWorkerStatusLabel, getWorkerAttentionDisplay, getWorkerAttentionPriority, getWorkerStatusGlyph } from "./display-grammar";
import { bold as legacyBold, themedPalette, type ThemedPalette } from "./theme";
import { formatCacheUsage, formatCompactTokenCount } from "./usage-format";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const TEAM_STATUS_TIPS = [
	"Use /team to view workers",
	"Use /team-result <id> for final output",
	"Use /team-copy <id> to copy a worker result",
	"Use /team-init [local] to rewrite default team",
	"Use /team-steer <id> <message> to guide a worker",
	"Use /team-stop <id> to cancel or close a worker",
	"Use /team <id> to view one worker details",
	"Use /team-enable [on/off] to manage orchestrator"
] as const;

const NON_TERMINAL_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting_followup"]);
const ACTIVE_ROW_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting_followup"]);
const TERMINAL_STATUSES = new Set<WorkerStatus>(["idle", "completed", "aborted", "error", "exited"]);
const RECENT_TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const MAX_WIDGET_WORKERS = 8;

const HEADER_WIDTH = 100;

export function hasAnimatedWorkers(state: PersistedTeamState): boolean {
	for (const worker of Object.values(state.activeWorkers)) {
		if (NON_TERMINAL_STATUSES.has(worker.status)) return true;
	}
	return false;
}

export interface WidgetRenderOptions {
	frame?: number;
	routingMode?: "team" | "solo";
	displayCost?: boolean;
	now?: number;
	theme?: Theme;
	width?: number;
}

export function getTeamStatusTip(index: number): string {
	const normalized = Math.max(0, Math.floor(index)) % TEAM_STATUS_TIPS.length;
	return TEAM_STATUS_TIPS[normalized]!;
}

export function buildTeamStatusLine(
	state: PersistedTeamState,
	routingMode: "team" | "solo" = "team",
	tip?: string,
	orchestratorWorking = false,
	theme?: Theme,
): string {
	const activityPlain = orchestratorWorking || hasActiveOrchestratorWork(state) ? "Working..." : "Idle";
	const status = routingMode === "solo" ? `Orchestrator · Solo · ${activityPlain}` : `Orchestrator · ${activityPlain}`;
	if (!theme) return truncateToWidth(tip ? `${status} · Tip: ${tip}` : status, HEADER_WIDTH);
	const palette = themedPalette(theme);
	const activity = orchestratorWorking || hasActiveOrchestratorWork(state) ? palette.warning("Working...") : palette.success("Idle");
	const themedStatus = routingMode === "solo" ? `Orchestrator · Solo · ${activity}` : `Orchestrator · ${activity}`;
	const line = tip ? `${themedStatus} · ${palette.dim("Tip:")} ${tip}` : themedStatus;
	return truncateToWidth(line, HEADER_WIDTH);
}

function hasActiveOrchestratorWork(state: PersistedTeamState): boolean {
	return state.relayQueue.length > 0 || Object.values(state.activeWorkers).some((worker) => isActiveSurfaceWorker(worker));
}

function statusGlyph(worker: WorkerRuntimeState, frame: number): string {
	if (worker.status === "running") return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
	return getWorkerStatusGlyph(worker);
}

function buildUsageLine(state: PersistedTeamState, palette: ThemedPalette): string | undefined {
	const usage = aggregateWorkerUsage(Object.values(state.activeWorkers), state.prunedWorkerUsageTotals);
	if (!hasWorkerUsage(usage)) return undefined;
	const base = `${palette.accent("Σ")} turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · $${usage.costUsd.toFixed(4)}`;
	const cache = formatCacheUsage(usage);
	if (!cache) return truncateToWidth(base, HEADER_WIDTH);
	const withCache = `${palette.accent("Σ")} turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · ${cache} · $${usage.costUsd.toFixed(4)}`;
	return truncateToWidth(visibleWidth(withCache) <= HEADER_WIDTH ? withCache : base, HEADER_WIDTH);
}

function buildStatusRow(state: PersistedTeamState, palette: ThemedPalette): { row: string; includesUsage: boolean } {
	const counts = buildCountsLine(state, palette);
	const usage = buildUsageLine(state, palette);
	if (!usage) return { row: counts, includesUsage: false };
	const combined = `${counts} · ${usage}`;
	return visibleWidth(combined) <= HEADER_WIDTH
		? { row: combined, includesUsage: true }
		: { row: counts, includesUsage: false };
}

function buildCountsLine(state: PersistedTeamState, palette: ThemedPalette): string {
	const counts = { relay: 0, running: 0, starting: 0, queued: 0, idle: 0, done: 0, ended: 0 };
	for (const worker of Object.values(state.activeWorkers)) {
		if (worker.pendingRelayQuestions.length > 0) counts.relay += 1;
		switch (worker.status) {
			case "running":
				counts.running += 1;
				break;
			case "starting":
				counts.starting += 1;
				break;
			case "waiting_followup":
				counts.queued += 1;
				break;
			case "idle":
				if (worker.finalAnswer) counts.done += 1;
				else counts.idle += 1;
				break;
			case "completed":
				counts.done += 1;
				break;
			case "aborted":
			case "error":
			case "exited":
				counts.ended += 1;
				break;
			default:
				break;
		}
	}

	const parts: string[] = [];
	if (counts.relay || state.relayQueue.length) parts.push(`${palette.warning("?")} ${palette.warning(String(Math.max(counts.relay, state.relayQueue.length)))} relay${Math.max(counts.relay, state.relayQueue.length) === 1 ? "" : "s"}`);
	if (counts.running) parts.push(`${palette.accent("▶")} ${palette.accent(String(counts.running))} running`);
	if (counts.starting) parts.push(`${palette.dim("◌")} ${palette.dim(String(counts.starting))} starting`);
	if (counts.queued) parts.push(`${palette.warning("▸")} ${palette.warning(String(counts.queued))} queued`);
	if (counts.idle) parts.push(`${palette.dim("○")} ${palette.dim(String(counts.idle))} idle`);
	if (counts.done) parts.push(`${palette.success("✓")} ${palette.success(String(counts.done))} done`);
	if (counts.ended) parts.push(`${palette.danger("✗")} ${palette.danger(String(counts.ended))} ended`);
	return truncateToWidth(parts.length === 0 ? palette.dim("no workers tracked") : parts.join("  "), HEADER_WIDTH);
}

function isActiveSurfaceWorker(worker: WorkerRuntimeState): boolean {
	return worker.pendingRelayQuestions.length > 0 || ACTIVE_ROW_STATUSES.has(worker.status);
}

function isRecentTerminalWorker(worker: WorkerRuntimeState, now: number): boolean {
	if (!TERMINAL_STATUSES.has(worker.status)) return false;
	return now - worker.lastEventAt <= RECENT_TERMINAL_RETENTION_MS;
}

function shouldRenderWorker(worker: WorkerRuntimeState, now: number): boolean {
	return isActiveSurfaceWorker(worker) || isRecentTerminalWorker(worker, now);
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function buildWorkerTitle(worker: WorkerRuntimeState): string {
	return worker.currentTask?.title?.trim() || worker.lastSummary?.headline?.trim() || formatWorkerStatusLabel(worker);
}

function getActiveElapsedStart(worker: WorkerRuntimeState): number {
	return worker.currentTask?.createdAt ?? worker.startedAt;
}

function buildWorkerCell(worker: WorkerRuntimeState, frame: number, now: number, connector: "├" | "└", palette: ThemedPalette): string {
	const glyph = statusGlyph(worker, frame);
	const identity = `${palette.bold(formatProfileLabel(worker.profileName))} ${formatWorkerDisplayId(worker.workerId)}`;
	if (getWorkerAttentionPriority(worker) === "completed_or_idle") {
		return truncateToWidth(`${connector} ${glyph} ${identity} · ${palette.success("Done")}`, HEADER_WIDTH, "…");
	}
	const title = buildWorkerTitle(worker);
	const statusOrElapsed = isActiveSurfaceWorker(worker) ? formatElapsed(now - getActiveElapsedStart(worker)) : formatWorkerStatusLabel(worker);
	const logical = `${connector} ${glyph} ${identity} · ${title} · ${statusOrElapsed}`;
	return truncateToWidth(logical, HEADER_WIDTH, "…");
}

function buildWorkerActivityLine(worker: WorkerRuntimeState, hasFollowingRow: boolean, palette: ThemedPalette): string | undefined {
	const attention = getWorkerAttentionDisplay(getWorkerAttentionPriority(worker));
	if (attention.key === "completed_or_idle") return undefined;
	const relay = worker.pendingRelayQuestions[0];
	const detail = relay?.question
		?? worker.lastSummary?.headline
		?? (worker.lastToolName ? `tool: ${worker.lastToolName}` : undefined)
		?? (worker.error ? palette.danger(`error: ${worker.error}`) : undefined);
	if (!detail) return undefined;
	const gutter = hasFollowingRow ? "│" : " ";
	const coloredLabel = attention.key === "needs_reply" ? palette.warning(attention.label) : palette.accent(attention.label);
	return truncateToWidth(`${gutter}  └ ${coloredLabel}: ${detail}`, HEADER_WIDTH, "…");
}

function buildAgentsSummaryLine(summaryParts: string[], palette: ThemedPalette): string {
	return truncateToWidth(`${palette.dim("└ +")} ${summaryParts.join(" · ")} ${palette.dim("· /team to view")}`, HEADER_WIDTH, "…");
}

function buildWorkerLines(workers: WorkerRuntimeState[], frame: number, now: number, hasSummaryRow: boolean, palette: ThemedPalette): string[] {
	const lines: string[] = [];
	workers.forEach((worker, index) => {
		const hasFollowingRow = index < workers.length - 1 || hasSummaryRow;
		lines.push(buildWorkerCell(worker, frame, now, hasFollowingRow ? "├" : "└", palette));
		const activity = buildWorkerActivityLine(worker, hasFollowingRow, palette);
		if (activity) lines.push(activity);
	});
	return lines;
}

function widgetPalette(theme?: Theme): ThemedPalette {
	if (theme) return themedPalette(theme);
	const identity = (text: string) => text;
	return {
		bold: legacyBold,
		dim: identity,
		muted: identity,
		accent: identity,
		accentBold: identity,
		success: identity,
		successBold: identity,
		warning: identity,
		warningBold: identity,
		danger: identity,
		dangerBold: identity,
		inverse: identity,
	};
}

export function buildTeamWidgetLines(state: PersistedTeamState, options: WidgetRenderOptions = {}): string[] {
	const frame = options.frame ?? 0;
	const routingMode = options.routingMode ?? "team";
	const displayCost = options.displayCost !== false;
	const now = options.now ?? Date.now();
	const width = options.width ?? HEADER_WIDTH;
	const palette = widgetPalette(options.theme);
	const allWorkers = Object.values(state.activeWorkers).sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
	const workers = allWorkers.filter((worker) => shouldRenderWorker(worker, now));
	if (routingMode === "solo") {
		// In solo mode the status line already says "Pi Agents Team — solo".
		// Only surface the widget when there is actual worker state worth showing.
		if (allWorkers.length === 0) return [];
		return [truncateToWidth(palette.dim("Pi Agents Team — solo"), width)];
	}
	if (allWorkers.length === 0 && (!displayCost || !buildUsageLine(state, palette, width))) return [];

	const status = displayCost ? buildStatusRow(state, palette, width) : { row: buildCountsLine(state, palette, width), includesUsage: false };
	const activeCount = allWorkers.filter((worker) => isActiveSurfaceWorker(worker)).length;
	const header = `${palette.accent("Pi Agents Team")} ${palette.dim("·")} active=${palette.bold(String(activeCount))} ${palette.dim("·")} relays=${palette.bold(String(state.relayQueue.length))}`;
	const lines = [truncateToWidth(header, width), status.row];
	if (displayCost && !status.includesUsage) {
		const usageLine = buildUsageLine(state, palette, width);
		if (usageLine) lines.push(usageLine);
	}
	const visibleWorkers = workers.slice(0, MAX_WIDGET_WORKERS);
	const hiddenByCap = workers.length - visibleWorkers.length;
	const hiddenByRetention = allWorkers.filter((worker) => TERMINAL_STATUSES.has(worker.status) && !shouldRenderWorker(worker, now)).length;
	const summaryParts: string[] = [];
	if (hiddenByCap > 0) summaryParts.push(`${hiddenByCap} more`);
	if (hiddenByRetention > 0) summaryParts.push(`${hiddenByRetention} old hidden`);
	if (visibleWorkers.length > 0 || summaryParts.length > 0) {
		const agentsHeader = `${palette.accent("● Agents")} ${palette.dim("·")} active=${palette.bold(String(activeCount))} ${palette.dim("·")} tracked=${palette.bold(String(allWorkers.length))}`;
		lines.push(truncateToWidth(agentsHeader, width, "…"));
		lines.push(...buildWorkerLines(visibleWorkers, frame, now, summaryParts.length > 0, palette, width));
		if (summaryParts.length > 0) lines.push(buildAgentsSummaryLine(summaryParts, palette, width));
	}
	return lines.map((line) => truncateToWidth(line, width));
}
