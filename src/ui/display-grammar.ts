import type { WorkerRuntimeState, WorkerStatus } from "../types";

export type WorkerAttentionPriority = "needs_reply" | "needs_recovery" | "in_progress" | "completed_or_idle";

export interface WorkerAttentionDisplay {
	key: WorkerAttentionPriority;
	rank: number;
	label: string;
	primaryAction: string;
}

export interface WorkerStatusDisplay {
	status: WorkerStatus;
	label: string;
	glyph: string;
	primaryAction: string;
}

const STATUS_DISPLAY: Record<WorkerStatus, Omit<WorkerStatusDisplay, "status">> = {
	starting: { label: "Starting", glyph: "◌", primaryAction: "Wait for startup" },
	running: { label: "Running", glyph: "▶", primaryAction: "Monitor progress" },
	waiting_followup: { label: "Waiting for follow-up", glyph: "▸", primaryAction: "Send follow-up" },
	idle: { label: "Idle", glyph: "○", primaryAction: "Reuse or close" },
	completed: { label: "Completed", glyph: "✓", primaryAction: "Review result" },
	aborted: { label: "Aborted", glyph: "✗", primaryAction: "Delegate fresh" },
	error: { label: "Error", glyph: "✗", primaryAction: "Recover or delegate fresh" },
	exited: { label: "Exited", glyph: "✗", primaryAction: "Delegate fresh" },
};

const ATTENTION_DISPLAY: Record<WorkerAttentionPriority, Omit<WorkerAttentionDisplay, "key">> = {
	needs_reply: { rank: 0, label: "Needs reply", primaryAction: "Answer relay" },
	needs_recovery: { rank: 1, label: "Needs recovery", primaryAction: "Recover or delegate fresh" },
	in_progress: { rank: 2, label: "In progress", primaryAction: "Monitor progress" },
	completed_or_idle: { rank: 3, label: "Completed or idle", primaryAction: "Review, reuse, or close" },
};

export const WORKER_ATTENTION_ORDER: readonly WorkerAttentionPriority[] = [
	"needs_reply",
	"needs_recovery",
	"in_progress",
	"completed_or_idle",
];

export function formatWorkerDisplayId(workerId: string): string {
	return `(${workerId})`;
}

export function formatProfileLabel(profileName: string): string {
	return profileName.trim() || "worker";
}

export function formatWorkerLabel(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `${formatProfileLabel(worker.profileName)} ${formatWorkerDisplayId(worker.workerId)}`;
}

export function formatWorkerToolLabel(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `${worker.workerId} (${formatProfileLabel(worker.profileName)})`;
}

export function formatWorkerStatusLabel(worker: Pick<WorkerRuntimeState, "status" | "finalAnswer"> | WorkerStatus): string {
	const status = typeof worker === "string" ? worker : worker.status;
	if (typeof worker !== "string" && status === "idle" && worker.finalAnswer) return "Done (idle)";
	return STATUS_DISPLAY[status].label;
}

export function getWorkerStatusDisplay(status: WorkerStatus): WorkerStatusDisplay {
	return { status, ...STATUS_DISPLAY[status] };
}

export function getWorkerStatusGlyph(worker: Pick<WorkerRuntimeState, "status" | "finalAnswer">): string {
	if (worker.status === "idle" && worker.finalAnswer) return "✓";
	return STATUS_DISPLAY[worker.status].glyph;
}

export function getWorkerAttentionPriority(worker: Pick<WorkerRuntimeState, "status" | "error" | "pendingRelayQuestions">): WorkerAttentionPriority {
	if (worker.pendingRelayQuestions.length > 0) return "needs_reply";
	if (worker.error || worker.status === "error" || worker.status === "aborted" || worker.status === "exited") return "needs_recovery";
	if (worker.status === "running" || worker.status === "starting" || worker.status === "waiting_followup") return "in_progress";
	return "completed_or_idle";
}

export function getWorkerAttentionDisplay(priority: WorkerAttentionPriority): WorkerAttentionDisplay {
	return { key: priority, ...ATTENTION_DISPLAY[priority] };
}

export function getWorkerPrimaryAction(worker: Pick<WorkerRuntimeState, "status" | "error" | "finalAnswer" | "pendingRelayQuestions">): string {
	if (worker.pendingRelayQuestions.length > 0) return ATTENTION_DISPLAY.needs_reply.primaryAction;
	if (worker.error) return ATTENTION_DISPLAY.needs_recovery.primaryAction;
	if (worker.status === "idle" && worker.finalAnswer) return "Review result";
	return STATUS_DISPLAY[worker.status].primaryAction;
}

export function buildWorkerActionHint(worker: Pick<WorkerRuntimeState, "status" | "error" | "finalAnswer" | "pendingRelayQuestions">): string {
	const attention = getWorkerAttentionDisplay(getWorkerAttentionPriority(worker));
	return `${attention.label}: ${getWorkerPrimaryAction(worker)}`;
}
