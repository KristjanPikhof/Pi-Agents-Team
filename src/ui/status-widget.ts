import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage";
import { formatProfileLabel, formatWorkerDisplayId, formatWorkerStatusLabel, getWorkerAttentionDisplay, getWorkerAttentionPriority, getWorkerStatusGlyph } from "./display-grammar";
import { bold } from "./theme";
import { formatCompactTokenCount } from "./usage-format";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const NON_TERMINAL_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting_followup"]);
const ACTIVE_ROW_STATUSES = new Set<WorkerStatus>(["starting", "running"]);
const TERMINAL_STATUSES = new Set<WorkerStatus>(["idle", "completed", "aborted", "error", "exited"]);
const RECENT_TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const MAX_WIDGET_WORKERS = 8;

const HEADER_WIDTH = 78;

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
}

export function buildTeamStatusLine(state: PersistedTeamState, routingMode: "team" | "solo" = "team"): string {
	if (routingMode === "solo") {
		return truncateToWidth("Pi Agents Team — solo", HEADER_WIDTH);
	}
	const workerCount = Object.keys(state.activeWorkers).length;
	const activeCount = Object.values(state.activeWorkers).filter((worker) => isActiveSurfaceWorker(worker)).length;
	const relayCount = state.relayQueue.length;
	return truncateToWidth(`${state.sessionMode} · active=${activeCount} · workers=${workerCount} · relays=${relayCount}`, HEADER_WIDTH);
}

function statusGlyph(worker: WorkerRuntimeState, frame: number): string {
	if (worker.status === "running") return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
	return getWorkerStatusGlyph(worker);
}

function buildUsageLine(state: PersistedTeamState): string | undefined {
	const usage = aggregateWorkerUsage(Object.values(state.activeWorkers), state.prunedWorkerUsageTotals);
	if (!hasWorkerUsage(usage)) return undefined;
	return truncateToWidth(
		`Σ turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · $${usage.costUsd.toFixed(4)}`,
		HEADER_WIDTH,
	);
}

function buildStatusRow(state: PersistedTeamState): { row: string; includesUsage: boolean } {
	const counts = buildCountsLine(state);
	const usage = buildUsageLine(state);
	if (!usage) return { row: counts, includesUsage: false };
	const combined = `${counts} · ${usage}`;
	return visibleWidth(combined) <= HEADER_WIDTH
		? { row: combined, includesUsage: true }
		: { row: counts, includesUsage: false };
}

function buildCountsLine(state: PersistedTeamState): string {
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
	if (counts.relay || state.relayQueue.length) parts.push(`? ${Math.max(counts.relay, state.relayQueue.length)} relay${Math.max(counts.relay, state.relayQueue.length) === 1 ? "" : "s"}`);
	if (counts.running) parts.push(`▶ ${counts.running} running`);
	if (counts.starting) parts.push(`◌ ${counts.starting} starting`);
	if (counts.queued) parts.push(`▸ ${counts.queued} queued`);
	if (counts.idle) parts.push(`○ ${counts.idle} idle`);
	if (counts.done) parts.push(`✓ ${counts.done} done`);
	if (counts.ended) parts.push(`✗ ${counts.ended} ended`);
	return truncateToWidth(parts.length === 0 ? "no workers tracked" : parts.join("  "), HEADER_WIDTH);
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

function buildWorkerCell(worker: WorkerRuntimeState, frame: number, now: number, connector: "├" | "└"): string {
	const glyph = statusGlyph(worker, frame);
	const identity = `${bold(formatProfileLabel(worker.profileName))} ${formatWorkerDisplayId(worker.workerId)}`;
	if (getWorkerAttentionPriority(worker) === "completed_or_idle") {
		return truncateToWidth(`${connector} ${glyph} ${identity} · Done`, HEADER_WIDTH, "…");
	}
	const title = buildWorkerTitle(worker);
	const statusOrElapsed = isActiveSurfaceWorker(worker) ? formatElapsed(now - getActiveElapsedStart(worker)) : formatWorkerStatusLabel(worker);
	const logical = `${connector} ${glyph} ${identity} · ${title} · ${statusOrElapsed}`;
	return truncateToWidth(logical, HEADER_WIDTH, "…");
}

function buildWorkerActivityLine(worker: WorkerRuntimeState, hasFollowingRow: boolean): string | undefined {
	const attention = getWorkerAttentionDisplay(getWorkerAttentionPriority(worker));
	if (attention.key === "completed_or_idle") return undefined;
	const relay = worker.pendingRelayQuestions[0];
	const detail = relay?.question
		?? worker.lastSummary?.headline
		?? (worker.lastToolName ? `tool: ${worker.lastToolName}` : undefined)
		?? (worker.error ? `error: ${worker.error}` : undefined);
	if (!detail) return undefined;
	const gutter = hasFollowingRow ? "│" : " ";
	return truncateToWidth(`${gutter}  └ ${attention.label}: ${detail}`, HEADER_WIDTH, "…");
}

function buildAgentsSummaryLine(summaryParts: string[]): string {
	return truncateToWidth(`└ + ${summaryParts.join(" · ")} · /team to view`, HEADER_WIDTH, "…");
}

function rightAlignToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${truncated}`;
}

function buildWorkerLines(workers: WorkerRuntimeState[], frame: number, now: number, hasSummaryRow: boolean): string[] {
	const lines: string[] = [];
	workers.forEach((worker, index) => {
		const hasFollowingRow = index < workers.length - 1 || hasSummaryRow;
		lines.push(buildWorkerCell(worker, frame, now, hasFollowingRow ? "├" : "└"));
		const activity = buildWorkerActivityLine(worker, hasFollowingRow);
		if (activity) lines.push(activity);
	});
	return lines;
}

export function buildTeamWidgetLines(state: PersistedTeamState, options: WidgetRenderOptions = {}): string[] {
	const frame = options.frame ?? 0;
	const routingMode = options.routingMode ?? "team";
	const displayCost = options.displayCost !== false;
	const now = options.now ?? Date.now();
	const allWorkers = Object.values(state.activeWorkers);
	const workers = allWorkers.filter((worker) => shouldRenderWorker(worker, now));
	if (routingMode === "solo") {
		// In solo mode the status line already says "Pi Agents Team — solo".
		// Only surface the widget when there is actual worker state worth showing.
		if (allWorkers.length === 0) return [];
		return [truncateToWidth("Pi Agents Team — solo", HEADER_WIDTH)];
	}
	if (allWorkers.length === 0 && (!displayCost || !buildUsageLine(state))) return [];

	const status = displayCost ? buildStatusRow(state) : { row: buildCountsLine(state), includesUsage: false };
	const activeCount = allWorkers.filter((worker) => isActiveSurfaceWorker(worker)).length;
	const lines = [truncateToWidth(`Pi Agents Team · active=${activeCount} · relays=${state.relayQueue.length}`, HEADER_WIDTH), status.row];
	if (displayCost && !status.includesUsage) {
		const usageLine = buildUsageLine(state);
		if (usageLine) lines.push(usageLine);
	}
	const visibleWorkers = workers.slice(0, MAX_WIDGET_WORKERS);
	const hiddenByCap = workers.length - visibleWorkers.length;
	const hiddenByRetention = allWorkers.filter((worker) => TERMINAL_STATUSES.has(worker.status) && !shouldRenderWorker(worker, now)).length;
	const queued = allWorkers.filter((worker) => worker.status === "waiting_followup" && worker.pendingRelayQuestions.length === 0).length;
	const summaryParts: string[] = [];
	if (queued > 0) summaryParts.push(`${queued} queued`);
	if (hiddenByCap > 0) summaryParts.push(`${hiddenByCap} more`);
	if (hiddenByRetention > 0) summaryParts.push(`${hiddenByRetention} old hidden`);
	if (visibleWorkers.length > 0 || summaryParts.length > 0) {
		lines.push(truncateToWidth(`● Agents · active=${activeCount} · tracked=${allWorkers.length}`, HEADER_WIDTH, "…"));
		lines.push(...buildWorkerLines(visibleWorkers, frame, now, summaryParts.length > 0));
		if (summaryParts.length > 0) lines.push(buildAgentsSummaryLine(summaryParts));
	}
	lines.push(rightAlignToWidth("tip: /team · /team-result <id> · /team-copy <id>", HEADER_WIDTH));
	return lines.map((line) => truncateToWidth(line, HEADER_WIDTH));
}
