import type { DelegatedTaskInput, WorkerRuntimeState, WorkerStatus } from "../types";
import { formatProfileLabel, formatWorkerDisplayId, formatWorkerLabel, formatWorkerStatusLabel, formatWorkerToolLabel } from "./display-grammar";

export const TOOL_SECTION_LABELS = {
	worker: "Worker",
	profile: "Profile",
	status: "Status",
	task: "Task",
	goal: "Goal",
	cwd: "CWD",
	pathScope: "Path scope",
	lifecycle: "Lifecycle",
	wait: "Wait",
	relayQuestions: "Pending relay questions",
	summary: "Headline",
	readFiles: "Read files (readFiles/files_read)",
	changedFiles: "Changed files (changedFiles/files_changed)",
	risks: "Risks",
	nextAction: "Next",
	usage: "Usage",
	context: "Context",
	error: "Error",
	finalAnswerNote: "Result note",
	finalAnswer: "Result",
	latestAssistantText: "Latest assistant text",
} as const;

const FINAL_ANSWER_MISSING_MESSAGE = "No <final_answer> block extracted yet.";

export interface WaitForAgentsFormatInput {
	reason: "all_terminal" | "timeout" | "aborted" | "relay_raised" | "no_workers";
	workers: WorkerRuntimeState[];
	newRelays?: Array<{ workerId: string; profileName: string; question: string; urgency: string }>;
}

export interface FormatWorkerDetailOptions {
	transcript?: string;
	compactUsage?: boolean;
	includeProfileLine?: boolean;
}

export function truncateList(items: readonly string[], max: number): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}… (+${items.length - max} more)`;
}

function formatWorkerResultTitle(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `${formatProfileLabel(worker.profileName)} ${formatWorkerDisplayId(worker.workerId)}`;
}

function shouldShowWorkerResultStatus(worker: WorkerRuntimeState): boolean {
	return !(Boolean(worker.finalAnswer) && (worker.status === "completed" || worker.status === "idle"));
}

function appendWorkerResultHeader(lines: string[], worker: WorkerRuntimeState): void {
	lines.push(formatWorkerResultTitle(worker));
	if (worker.currentTask?.title) lines.push(`${TOOL_SECTION_LABELS.task}: ${worker.currentTask.title}`);
	if (shouldShowWorkerResultStatus(worker)) lines.push(`${TOOL_SECTION_LABELS.status}: ${worker.status} (${formatWorkerStatusLabel(worker)})`);
	if (worker.error) lines.push(`${TOOL_SECTION_LABELS.error}: ${worker.error}`);
}

function appendRelayQuestions(lines: string[], worker: WorkerRuntimeState): void {
	if (worker.pendingRelayQuestions.length === 0) return;
	lines.push("", `${TOOL_SECTION_LABELS.relayQuestions}:`);
	for (const relay of worker.pendingRelayQuestions) {
		lines.push(`- [${relay.urgency}] ${relay.question}`);
		lines.push(`  assumption: ${relay.assumption}`);
	}
}

function appendFinalAnswer(lines: string[], worker: WorkerRuntimeState): void {
	const finalAnswer = worker.finalAnswer?.trim();
	if (!finalAnswer) {
		lines.push("", `${TOOL_SECTION_LABELS.finalAnswer}:`, FINAL_ANSWER_MISSING_MESSAGE);
		return;
	}
	lines.push("", `${TOOL_SECTION_LABELS.finalAnswer}:`, finalAnswer);
}

export function formatWorkerListItem(worker: WorkerRuntimeState): string {
	const parts = [formatWorkerToolLabel(worker), `status=${worker.status} (${formatWorkerStatusLabel(worker)})`];
	if (worker.currentTask?.title) parts.push(`task=${worker.currentTask.title}`);
	if (worker.pendingRelayQuestions.length > 0) parts.push(`relays=${worker.pendingRelayQuestions.length}`);
	return parts.join(" · ");
}

export function formatWorkers(workers: readonly WorkerRuntimeState[]): string {
	if (workers.length === 0) return "No active or persisted workers.";
	return workers.map((worker) => `- ${formatWorkerListItem(worker)}`).join("\n");
}

export interface DelegateTaskFormatInput {
	worker: Pick<WorkerRuntimeState, "workerId" | "profileName" | "status" | "currentTask">;
	task?: DelegatedTaskInput;
	reuseWorkerId?: string;
}

export function formatDelegateTaskResult(result: DelegateTaskFormatInput): string {
	const task = result.task ?? result.worker.currentTask;
	const title = task?.title ?? "delegated task";
	const taskLabel = task?.taskId ? `${title} (${task.taskId})` : title;
	const action = result.reuseWorkerId ? "Reusing" : "Created";
	const lines = [`${action} ${formatWorkerResultTitle(result.worker)}`, `${TOOL_SECTION_LABELS.task}: ${taskLabel}`];
	if (task?.cwd) lines.push(`Path: ${task.cwd}`);
	return lines.join("\n");
}

export interface AgentMessageFormatInput {
	worker: Pick<WorkerRuntimeState, "workerId" | "profileName" | "status">;
	delivery: "steer" | "follow_up" | "prompt";
	previousStatus?: WorkerStatus;
}

export function formatAgentMessageResult(result: AgentMessageFormatInput): string {
	const previousStatus = result.previousStatus ?? result.worker.status;
	const label = formatWorkerLabel(result.worker);
	if (result.delivery === "steer") return `Steering running agent ${label}.`;
	if (result.delivery === "follow_up") return `Queued follow-up for ${label}.`;
	if (previousStatus === "idle") return `Waking idle agent ${label}.`;
	if (previousStatus === "waiting_followup") return `Resuming agent ${label}.`;
	return `Sent prompt to ${label}.`;
}

function formatWaitWorkerIds(workers: readonly WorkerRuntimeState[]): string {
	return `[${workers.map((worker) => JSON.stringify(worker.workerId)).join(",")}]`;
}

function appendWaitWorkers(lines: string[], workers: readonly WorkerRuntimeState[]): void {
	lines.push("", "Workers:", formatWorkers(workers));
}

function appendWaitRelayGuidance(lines: string[], result: WaitForAgentsFormatInput): void {
	const relays = result.newRelays ?? [];
	if (relays.length === 0) return;
	lines.push("", `${TOOL_SECTION_LABELS.relayQuestions}:`);
	for (const [index, relay] of relays.entries()) {
		lines.push(`${index + 1}. ${relay.profileName} ${formatWorkerDisplayId(relay.workerId)} [${relay.urgency}]`);
		lines.push(`   ${relay.question}`);
	}
	lines.push(`${TOOL_SECTION_LABELS.nextAction}: answer with agent_message, then wait again for ${formatWaitWorkerIds(result.workers)}.`);
}

export function formatWaitForAgentsResult(result: WaitForAgentsFormatInput): string {
	if (result.reason === "no_workers") {
		return ["No agents to wait for.", `${TOOL_SECTION_LABELS.nextAction}: delegate a task first.`].join("\n");
	}

	const lines: string[] = [];
	if (result.reason === "all_terminal") {
		lines.push(`Done: ${result.workers.length} agent(s) finished or stopped.`, `${TOOL_SECTION_LABELS.nextAction}: read results with agent_result.`);
	} else if (result.reason === "relay_raised") {
		const count = result.newRelays?.length ?? 0;
		lines.push(`Needs reply: ${count} relay question(s).`);
		appendWaitRelayGuidance(lines, result);
	} else if (result.reason === "timeout") {
		lines.push("Still waiting: some agents are still running.", `${TOOL_SECTION_LABELS.nextAction}: wait again or inspect status.`);
	} else {
		lines.push("Wait cancelled: stopped before all agents finished.", `${TOOL_SECTION_LABELS.nextAction}: inspect status or cancel unwanted agents.`);
	}
	appendWaitWorkers(lines, result.workers);
	return lines.join("\n");
}

export function formatWorkerCompact(worker: WorkerRuntimeState): string {
	const lines: string[] = [];
	appendWorkerResultHeader(lines, worker);

	appendRelayQuestions(lines, worker);
	appendFinalAnswer(lines, worker);
	return lines.join("\n");
}

export function formatWorkerDetail(worker: WorkerRuntimeState, options: FormatWorkerDetailOptions = {}): string {
	const lines: string[] = [];
	appendWorkerResultHeader(lines, worker);
	appendRelayQuestions(lines, worker);
	appendFinalAnswer(lines, worker);

	if (!worker.finalAnswer?.trim() && options.transcript && options.transcript.trim()) {
		lines.push("", `${TOOL_SECTION_LABELS.latestAssistantText}:`, options.transcript.trim());
	}

	return lines.join("\n");
}
