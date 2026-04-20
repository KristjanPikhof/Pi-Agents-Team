import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const NON_TERMINAL_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting_followup"]);

const HEADER_WIDTH = 78;
const COLUMN_WIDTH = 38;
const COLUMN_SEPARATOR = "  ";
const COLUMN_THRESHOLD = 6;
const MAX_COLUMN_ROWS = 8;
const MAX_SINGLE_COL_WORKERS = 8;

export function hasAnimatedWorkers(state: PersistedTeamState): boolean {
	for (const worker of Object.values(state.activeWorkers)) {
		if (NON_TERMINAL_STATUSES.has(worker.status)) return true;
	}
	return false;
}

export interface WidgetRenderOptions {
	frame?: number;
}

export function buildTeamStatusLine(state: PersistedTeamState): string {
	const workerCount = Object.keys(state.activeWorkers).length;
	const relayCount = state.relayQueue.length;
	return truncateToWidth(`${state.sessionMode} · workers=${workerCount} · relays=${relayCount}`, HEADER_WIDTH);
}

function statusGlyph(worker: WorkerRuntimeState, frame: number): string {
	switch (worker.status) {
		case "running":
			return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
		case "starting":
			return "◌";
		case "waiting_followup":
			return "▸";
		case "idle":
			return worker.finalAnswer ? "✓" : "○";
		case "completed":
			return "✓";
		case "aborted":
		case "error":
		case "exited":
			return "✗";
		default:
			return "·";
	}
}

function padToWidth(text: string, width: number): string {
	const gap = Math.max(0, width - visibleWidth(text));
	return `${text}${" ".repeat(gap)}`;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${value}`;
}

function buildUsageLine(state: PersistedTeamState): string | undefined {
	let turns = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const worker of Object.values(state.activeWorkers)) {
		turns += worker.usage.turns;
		inputTokens += worker.usage.inputTokens;
		outputTokens += worker.usage.outputTokens;
		costUsd += worker.usage.costUsd;
	}
	if (turns === 0 && inputTokens === 0 && outputTokens === 0 && costUsd === 0) return undefined;
	return truncateToWidth(
		`Σ turns=${turns}  in=${formatTokens(inputTokens)}  out=${formatTokens(outputTokens)}  cost=$${costUsd.toFixed(4)}`,
		HEADER_WIDTH,
	);
}

function buildCountsLine(state: PersistedTeamState): string {
	const counts = { running: 0, starting: 0, queued: 0, idle: 0, done: 0, ended: 0 };
	for (const worker of Object.values(state.activeWorkers)) {
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
	if (counts.running) parts.push(`▶ ${counts.running} running`);
	if (counts.starting) parts.push(`◌ ${counts.starting} starting`);
	if (counts.queued) parts.push(`▸ ${counts.queued} queued`);
	if (counts.idle) parts.push(`○ ${counts.idle} idle`);
	if (counts.done) parts.push(`✓ ${counts.done} done`);
	if (counts.ended) parts.push(`✗ ${counts.ended} ended`);
	if (state.relayQueue.length) parts.push(`? ${state.relayQueue.length} relay${state.relayQueue.length === 1 ? "" : "s"}`);
	return truncateToWidth(parts.length === 0 ? "no workers tracked" : parts.join("  "), HEADER_WIDTH);
}

function buildWorkerCell(worker: WorkerRuntimeState, frame: number, cellWidth: number): string {
	const glyph = statusGlyph(worker, frame);
	const detail = worker.lastSummary?.headline
		?? worker.currentTask?.title
		?? (worker.error ? `error: ${worker.error}` : worker.status);
	const logical = `${glyph} ${worker.workerId} ${worker.profileName} — ${detail}`;
	return truncateToWidth(logical, cellWidth, "…");
}

function buildWorkerLines(workers: WorkerRuntimeState[], frame: number): { lines: string[]; hiddenCount: number } {
	if (workers.length === 0) return { lines: [], hiddenCount: 0 };

	if (workers.length <= COLUMN_THRESHOLD) {
		const visible = workers.slice(0, MAX_SINGLE_COL_WORKERS);
		const lines = visible.map((worker) => buildWorkerCell(worker, frame, HEADER_WIDTH));
		return { lines, hiddenCount: workers.length - visible.length };
	}

	const maxWorkers = MAX_COLUMN_ROWS * 2;
	const visible = workers.slice(0, maxWorkers);
	const rowCount = Math.ceil(visible.length / 2);
	const left = visible.slice(0, rowCount);
	const right = visible.slice(rowCount);
	const lines: string[] = [];
	for (let i = 0; i < rowCount; i += 1) {
		const leftCell = left[i] ? buildWorkerCell(left[i]!, frame, COLUMN_WIDTH) : "";
		const rightCell = right[i] ? buildWorkerCell(right[i]!, frame, COLUMN_WIDTH) : "";
		const paddedLeft = padToWidth(leftCell, COLUMN_WIDTH);
		lines.push(truncateToWidth(`${paddedLeft}${COLUMN_SEPARATOR}${rightCell}`, HEADER_WIDTH));
	}
	return { lines, hiddenCount: workers.length - visible.length };
}

export function buildTeamWidgetLines(state: PersistedTeamState, options: WidgetRenderOptions = {}): string[] {
	const frame = options.frame ?? 0;
	const workers = Object.values(state.activeWorkers).sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
	if (workers.length === 0) return [];

	const lines = ["Pi Agent Team", buildCountsLine(state)];
	const { lines: workerLines, hiddenCount } = buildWorkerLines(workers, frame);
	lines.push(...workerLines);
	if (hiddenCount > 0) {
		lines.push(truncateToWidth(`  +${hiddenCount} more · /team to view`, HEADER_WIDTH));
	}
	lines.push("tip: /team · /agent-result <id> · /team-copy <id>");
	return lines.map((line) => truncateToWidth(line, HEADER_WIDTH));
}
