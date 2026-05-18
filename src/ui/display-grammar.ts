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
	created: { label: "Created", glyph: "·", primaryAction: "Wait for startup" },
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
	in_progress: { rank: 2, label: "Working", primaryAction: "Monitor progress" },
	completed_or_idle: { rank: 3, label: "Done", primaryAction: "Review, reuse, or close" },
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

export function formatWorkerIdList(workerIds: readonly string[]): string {
	return workerIds.map((workerId) => workerId.trim()).filter(Boolean).join(", ");
}

export function formatWorkerIdListSuffix(workerIds: readonly string[]): string {
	const ids = formatWorkerIdList(workerIds);
	return ids ? ` (${ids})` : "";
}

export type AgentToolName = "delegate_task" | "agent_result" | "wait_for_agents" | "agent_message" | "agent_status" | "ping_agents" | "agent_cancel";

export interface AgentToolTitleArgs {
	profileName?: string;
	workerId?: string;
	workerIds?: readonly string[];
}

export function buildAgentToolCallTitle(toolName: AgentToolName, args: AgentToolTitleArgs = {}): string {
	switch (toolName) {
		case "delegate_task":
			return `Delegating to ${formatProfileLabel(args.profileName ?? "")}`;
		case "agent_result":
			return `Reading agent result${formatWorkerIdListSuffix(args.workerId ? [args.workerId] : [])}`;
		case "wait_for_agents":
			return `Waiting for agents${formatWorkerIdListSuffix(args.workerIds ?? [])}`;
		case "agent_message":
			return `Messaging agent${formatWorkerIdListSuffix(args.workerId ? [args.workerId] : [])}`;
		case "agent_status":
			return args.workerId ? `Checking agent status${formatWorkerIdListSuffix([args.workerId])}` : "Checking agent status";
		case "ping_agents":
			return `Pinging agents${formatWorkerIdListSuffix(args.workerIds ?? [])}`;
		case "agent_cancel":
			return `Cancelling agent${formatWorkerIdListSuffix(args.workerId ? [args.workerId] : [])}`;
	}
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
	if (worker.status === "created" || worker.status === "running" || worker.status === "starting" || worker.status === "waiting_followup") return "in_progress";
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

export function formatWorkerStartedToast(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `${worker.workerId} (${formatProfileLabel(worker.profileName)}) started`;
}

export function formatWorkersStartedToast(workers: readonly Pick<WorkerRuntimeState, "workerId">[]): string {
	return `${workers.length} workers started: ${formatWorkerIdList(workers.map((worker) => worker.workerId))}`;
}

export function formatTerminalStatusAction(status: WorkerStatus): "complete" | "cancelled" | "failed" | "exited" {
	if (status === "aborted") return "cancelled";
	if (status === "error") return "failed";
	if (status === "exited") return "exited";
	return "complete";
}

export function formatWorkerTerminalToast(worker: Pick<WorkerRuntimeState, "workerId" | "profileName" | "status">): string {
	return `${worker.workerId} (${formatProfileLabel(worker.profileName)}) ${formatTerminalStatusAction(worker.status)}`;
}

export function formatWorkersTerminalToast(workers: readonly Pick<WorkerRuntimeState, "workerId" | "status">[]): string {
	const items = workers.map((worker) => `${worker.workerId} ${formatTerminalStatusAction(worker.status)}`);
	return `${workers.length} workers done: ${items.join(", ")}`;
}

export function formatRelayToast(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">, question: string): string {
	const preview = question.replace(/\s+/g, " ").trim().slice(0, 120);
	return `Reply to ${worker.workerId} (${formatProfileLabel(worker.profileName)}): ${preview}`;
}

export function formatCommandWarning(message: string): string {
	return `Warning — ${message}`;
}
