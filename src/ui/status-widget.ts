import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const NON_TERMINAL_STATUSES = new Set<WorkerStatus>(["starting", "running", "waiting_followup"]);

export function hasAnimatedWorkers(state: PersistedTeamState): boolean {
	for (const worker of Object.values(state.activeWorkers)) {
		if (NON_TERMINAL_STATUSES.has(worker.status)) return true;
	}
	return false;
}

export interface WidgetRenderOptions {
	frame?: number;
	maxVisibleWorkers?: number;
}

export function buildTeamStatusLine(state: PersistedTeamState): string {
	const workerCount = Object.keys(state.activeWorkers).length;
	const relayCount = state.relayQueue.length;
	return `${state.sessionMode} · workers=${workerCount} · relays=${relayCount}`;
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

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
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
	if (parts.length === 0) return "no workers tracked";
	return parts.join("  ");
}

function buildWorkerLine(worker: WorkerRuntimeState, frame: number): string {
	const glyph = statusGlyph(worker, frame);
	const detail = worker.lastSummary?.headline
		?? worker.currentTask?.title
		?? (worker.error ? `error: ${worker.error}` : worker.status);
	return `${glyph} ${worker.workerId} ${worker.profileName} — ${truncate(detail, 48)}`;
}

export function buildTeamWidgetLines(state: PersistedTeamState, options: WidgetRenderOptions = {}): string[] {
	const frame = options.frame ?? 0;
	const maxVisible = options.maxVisibleWorkers ?? 6;
	const workers = Object.values(state.activeWorkers).sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
	const lines = ["Pi Agent Team", buildCountsLine(state)];

	if (workers.length === 0) {
		lines.push("no tracked workers · /delegate via the orchestrator, then /team to inspect");
		return lines;
	}

	const visible = workers.slice(0, maxVisible);
	for (const worker of visible) {
		lines.push(buildWorkerLine(worker, frame));
	}
	if (workers.length > visible.length) {
		lines.push(`  +${workers.length - visible.length} more · /team to view`);
	}
	lines.push("tip: /team · /agent-result <id>");
	return lines;
}
