import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types.js";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage.js";
import { buildRosterSections } from "./dashboard.js";
import { areAllWorkersFinished, formatProfileLabel, formatWorkerDisplayId, formatWorkerStatusLabel, getWorkerAttentionColor, getWorkerAttentionDisplay, getWorkerAttentionPriority, getWorkerPrimaryAction, getWorkerStatusGlyph } from "./display-grammar.js";
import { bold as legacyBold, sanitizeTerminalText, themedPalette, type ThemedPalette } from "./theme.js";
import { formatCacheUsage, formatCacheUsageWithHit, formatCompactTokenCount } from "./usage-format.js";

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
const RECENT_FAILURE_RETENTION_MS = 5 * 60 * 1000;
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
	width = HEADER_WIDTH,
): string {
	const activityPlain = orchestratorWorking || hasActiveOrchestratorWork(state) ? "Working..." : "Idle";
	const status = routingMode === "solo" ? `Orchestrator · Solo · ${activityPlain}` : `Orchestrator · ${activityPlain}`;
	if (!theme) return truncateToWidth(tip ? `${status} · Tip: ${tip}` : status, width);
	const palette = themedPalette(theme);
	const activity = orchestratorWorking || hasActiveOrchestratorWork(state) ? palette.warning("Working...") : palette.success("Idle");
	const themedStatus = routingMode === "solo" ? `Orchestrator · Solo · ${activity}` : `Orchestrator · ${activity}`;
	const line = tip ? `${themedStatus} · ${palette.dim("Tip:")} ${tip}` : themedStatus;
	return truncateToWidth(line, width);
}

function hasActiveOrchestratorWork(state: PersistedTeamState): boolean {
	return state.relayQueue.length > 0 || Object.values(state.activeWorkers).some((worker) => isActiveSurfaceWorker(worker));
}

function statusGlyph(worker: WorkerRuntimeState, frame: number): string {
	if (worker.status === "running") return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
	return getWorkerStatusGlyph(worker);
}

function buildUsageLine(state: PersistedTeamState, palette: ThemedPalette, width: number): string | undefined {
	const usage = aggregateWorkerUsage(Object.values(state.activeWorkers), state.prunedWorkerUsageTotals);
	if (!hasWorkerUsage(usage)) return undefined;
	const base = `${palette.accent("Σ")} turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · $${usage.costUsd.toFixed(4)}`;
	const cache = formatCacheUsage(usage);
	if (!cache) return truncateToWidth(base, width);
	const cacheWithHit = formatCacheUsageWithHit(usage) ?? cache;
	const withCacheAndHit = `${palette.accent("Σ")} turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · ${cacheWithHit} · $${usage.costUsd.toFixed(4)}`;
	if (visibleWidth(withCacheAndHit) <= width) return truncateToWidth(withCacheAndHit, width);
	const withCache = `${palette.accent("Σ")} turns=${usage.turns} · in=${formatCompactTokenCount(usage.inputTokens)} · out=${formatCompactTokenCount(usage.outputTokens)} · ${cache} · $${usage.costUsd.toFixed(4)}`;
	return truncateToWidth(visibleWidth(withCache) <= width ? withCache : base, width);
}

function buildCountsLine(state: PersistedTeamState, palette: ThemedPalette, width: number): string {
	const counts = { relay: 0, running: 0, starting: 0, queued: 0, idle: 0, done: 0, recovery: 0 };
	for (const worker of Object.values(state.activeWorkers)) {
		const attention = getWorkerAttentionPriority(worker);
		if (attention === "needs_reply") {
			counts.relay += 1;
			continue;
		}
		if (attention === "needs_recovery") {
			counts.recovery += 1;
			continue;
		}
		switch (worker.status) {
			case "running":
				counts.running += 1;
				break;
			case "starting":
			case "created":
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
			default:
				break;
		}
	}
	if (areAllWorkersFinished(state)) {
		return truncateToWidth(`${palette.success("✓ All agents finished")} ${palette.dim(`· ${counts.done} done`)}`, width);
	}

	const parts: string[] = [];
	const relayCount = Math.max(counts.relay, state.relayQueue.length);
	if (relayCount) parts.push(palette.warning(`? ${relayCount} ${relayCount === 1 ? "needs" : "need"} reply`));
	if (counts.recovery) parts.push(palette.danger(`✗ ${counts.recovery} ${counts.recovery === 1 ? "needs" : "need"} recovery`));
	if (counts.running) parts.push(palette.accent(`▶ ${counts.running} running`));
	if (counts.starting) parts.push(palette.accent(`◌ ${counts.starting} starting`));
	if (counts.queued) parts.push(palette.accent(`▸ ${counts.queued} queued`));
	if (counts.idle) parts.push(palette.dim(`○ ${counts.idle} idle`));
	if (counts.done) parts.push(palette.dim(`✓ ${counts.done} done`));
	return truncateToWidth(parts.length === 0 ? palette.dim("no workers tracked") : parts.join("  "), width);
}

function isActiveSurfaceWorker(worker: WorkerRuntimeState): boolean {
	return worker.pendingRelayQuestions.length > 0 || NON_TERMINAL_STATUSES.has(worker.status) || worker.status === "created";
}

function shouldRenderWorker(worker: WorkerRuntimeState, now: number): boolean {
	return isActiveSurfaceWorker(worker)
		|| (getWorkerAttentionPriority(worker) === "needs_recovery" && now - worker.lastEventAt <= RECENT_FAILURE_RETENTION_MS);
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
	return singleLine(worker.currentTask?.title ?? "") || singleLine(worker.lastSummary?.headline ?? "") || formatWorkerStatusLabel(worker);
}

function singleLine(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function workerIdentity(worker: WorkerRuntimeState, palette: ThemedPalette): string {
	const color = getWorkerAttentionColor(getWorkerAttentionPriority(worker), palette);
	const id = formatWorkerDisplayId(singleLine(worker.workerId));
	const profile = truncateToWidth(formatProfileLabel(singleLine(worker.profileName)), Math.max(1, 24 - visibleWidth(id) - 1), "…");
	return `${palette.bold(color(profile))} ${color(id)}`;
}

function alignElapsed(text: string, elapsed: string, palette: ThemedPalette, width: number): string {
	const contentWidth = Math.max(0, width - visibleWidth(elapsed) - 1);
	return truncateToWidth(`${truncateToWidth(text, contentWidth, "…", true)} ${palette.dim(elapsed)}`, width);
}

function buildWorkerLines(workers: WorkerRuntimeState[], frame: number, now: number, palette: ThemedPalette, width: number): string[] {
	const lines: string[] = [];
	const wide = width >= 60;
	const identityWidth = Math.min(24, Math.max(0, ...workers.map((worker) => visibleWidth(workerIdentity(worker, palette)))));
	for (const worker of workers) {
		const attention = getWorkerAttentionPriority(worker);
		const color = getWorkerAttentionColor(attention, palette);
		const urgent = attention === "needs_reply" || attention === "needs_recovery";
		const label = urgent ? getWorkerAttentionDisplay(attention).label : formatWorkerStatusLabel(worker);
		const title = buildWorkerTitle(worker);
		const identity = workerIdentity(worker, palette);
		const prefix = `${color(statusGlyph(worker, frame))} ${wide ? truncateToWidth(identity, identityWidth, "…", true) : identity}`;
		let content = color(label);
		if (wide && !urgent && title !== label) {
			content = worker.status === "running" ? title : `${color(label)} · ${title}`;
		}
		const end = NON_TERMINAL_STATUSES.has(worker.status) || worker.status === "created" ? now : worker.lastEventAt;
		const elapsed = formatElapsed(end - (worker.currentTask?.createdAt ?? worker.startedAt));
		lines.push(alignElapsed(`${prefix}  ${content}`, elapsed, palette, width));
		if (!wide && !urgent && title !== label) lines.push(truncateToWidth(`  ${palette.dim(title)}`, width, "…"));
		if (urgent) {
			const detail = attention === "needs_reply" ? worker.pendingRelayQuestions[0]?.question : worker.error || getWorkerPrimaryAction(worker);
			if (detail) lines.push(truncateToWidth(`  ${color(singleLine(detail))}`, width, "…"));
		}
	}
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
		toolRead: identity,
		toolSearch: identity,
		selected: identity,
	};
}

export function buildTeamWidgetLines(state: PersistedTeamState, options: WidgetRenderOptions = {}): string[] {
	const frame = options.frame ?? 0;
	const routingMode = options.routingMode ?? "team";
	const displayCost = options.displayCost !== false;
	const now = options.now ?? Date.now();
	const width = options.width ?? HEADER_WIDTH;
	const palette = widgetPalette(options.theme);
	const allWorkers = buildRosterSections(state).flatMap((section) => section.workers);
	const workers = allWorkers.filter((worker) => shouldRenderWorker(worker, now));
	if (routingMode === "solo") {
		// In solo mode the status line already says "Pi Agents Team — solo".
		// Only surface the widget when there is actual worker state worth showing.
		if (allWorkers.length === 0) return [];
		return [truncateToWidth(palette.dim("Pi Agents Team — solo"), width)];
	}
	if (allWorkers.length === 0 && (!displayCost || !buildUsageLine(state, palette, width))) return [];

	const title = palette.accent("Pi Agents Team");
	const counts = buildCountsLine(state, palette, width);
	const header = `${title} ${palette.dim("·")} ${counts}`;
	const lines = visibleWidth(header) <= width ? [header] : [truncateToWidth(title, width), counts];
	const visibleWorkers = workers.slice(0, MAX_WIDGET_WORKERS);
	const hiddenWorkers = workers.slice(MAX_WIDGET_WORKERS);
	const hiddenActive = hiddenWorkers.filter(isActiveSurfaceWorker).length;
	const hiddenRecovery = hiddenWorkers.length - hiddenActive;
	const summaryParts: string[] = [];
	if (hiddenActive > 0) summaryParts.push(palette.accent(`${hiddenActive} active`));
	if (hiddenRecovery > 0) summaryParts.push(palette.danger(`${hiddenRecovery} need recovery`));
	lines.push(...buildWorkerLines(visibleWorkers, frame, now, palette, width));
	if (summaryParts.length > 0) lines.push(`+ ${summaryParts.join(" · ")} ${palette.dim("· /team to view")}`);
	if (allWorkers.length > 0 && workers.length === 0) {
		const hasResults = allWorkers.some((worker) => worker.finalAnswer || worker.status === "completed");
		lines.push(palette.dim(hasResults ? "/team-result <id> · /team for all results" : "/team for worker details"));
	}
	if (displayCost) {
		const usageLine = buildUsageLine(state, palette, width);
		if (usageLine) lines.push(usageLine);
	}
	return lines.map((line) => truncateToWidth(line, width));
}
