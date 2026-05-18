import type { DelegatedTaskInput, TeamPathScope, WorkerRuntimeState } from "../types";
import { formatProfileLabel, formatWorkerDisplayId, formatWorkerStatusLabel, formatWorkerToolLabel } from "./display-grammar";
import { bold } from "./theme";
import { formatCompactTokenCount, formatContextBudget } from "./usage-format";

export const TOOL_SECTION_LABELS = {
	worker: "Worker",
	profile: "Profile",
	status: "Status",
	task: "Task",
	goal: "Goal",
	cwd: "CWD",
	pathScope: "Path scope",
	lifecycle: "Lifecycle",
	resultReason: "Result reason",
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

function formatUsage(worker: WorkerRuntimeState, compact: boolean): string {
	const input = compact ? formatCompactTokenCount(worker.usage.inputTokens) : String(worker.usage.inputTokens);
	const output = compact ? formatCompactTokenCount(worker.usage.outputTokens) : String(worker.usage.outputTokens);
	return `${TOOL_SECTION_LABELS.usage}: turns=${worker.usage.turns} input=${input} output=${output} cost=$${worker.usage.costUsd.toFixed(4)}`;
}

function appendListLine(lines: string[], label: string, items: readonly string[], max?: number): void {
	if (items.length === 0) return;
	lines.push(`${label}: ${max ? truncateList(items, max) : items.join(", ")}`);
}

function appendWorkerSummary(lines: string[], worker: WorkerRuntimeState, limits?: { readFiles: number; changedFiles: number; risks: number }): void {
	const summary = worker.lastSummary;
	if (!summary) return;
	if (summary.headline) lines.push(`${TOOL_SECTION_LABELS.summary}: ${summary.headline}`);
	appendListLine(lines, TOOL_SECTION_LABELS.readFiles, summary.readFiles, limits?.readFiles);
	appendListLine(lines, TOOL_SECTION_LABELS.changedFiles, summary.changedFiles, limits?.changedFiles);
	appendListLine(lines, TOOL_SECTION_LABELS.risks, summary.risks, limits?.risks);
	if (summary.nextRecommendation) lines.push(`${TOOL_SECTION_LABELS.nextAction}: ${summary.nextRecommendation}`);
}

function formatWorkerResultTitle(worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `${bold(formatProfileLabel(worker.profileName))} ${formatWorkerDisplayId(worker.workerId)}`;
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

function appendUsageAndContext(lines: string[], worker: WorkerRuntimeState, compactUsage: boolean): void {
	lines.push(formatUsage(worker, compactUsage));
	const contextBudget = formatContextBudget(worker.usage);
	if (contextBudget) lines.push(`${TOOL_SECTION_LABELS.context}: ${contextBudget}`);
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

function formatPathScope(pathScope: TeamPathScope): string {
	const mode = pathScope.allowWrite ? "read/write" : "read-only";
	return `${mode} ${pathScope.roots.join(", ")}`;
}

export function formatDelegateTaskResult(result: DelegateTaskFormatInput): string {
	const task = result.task ?? result.worker.currentTask;
	const title = task?.title ?? "delegated task";
	const taskLabel = task?.taskId ? `${title} (${task.taskId})` : title;
	const lines = [formatWorkerResultTitle(result.worker), `${TOOL_SECTION_LABELS.task}: ${taskLabel}`];
	lines.push(`${TOOL_SECTION_LABELS.nextAction}: wait_for_agents workerIds=["${result.worker.workerId}"]`);
	return lines.join("\n");
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
		lines.push(`${index + 1}. ${relay.workerId} (${relay.profileName}) urgency=${relay.urgency}`);
		lines.push(`   question: ${relay.question}`);
		lines.push(`   reply: agent_message {"workerId":${JSON.stringify(relay.workerId)},"message":"<answer>"}`);
	}
	lines.push(`${TOOL_SECTION_LABELS.nextAction}: answer each relay via agent_message, then call wait_for_agents {"workerIds":${formatWaitWorkerIds(result.workers)}} to resume.`);
}

export function formatWaitForAgentsResult(result: WaitForAgentsFormatInput): string {
	const lines = [`${TOOL_SECTION_LABELS.resultReason}: ${result.reason}`];
	if (result.reason === "no_workers") {
		lines.push("No tracked workers to wait on.", `${TOOL_SECTION_LABELS.nextAction}: call delegate_task before waiting for agents.`);
		return lines.join("\n");
	}

	if (result.reason === "all_terminal") {
		lines.push(`All ${result.workers.length} worker(s) reached terminal status.`, `${TOOL_SECTION_LABELS.nextAction}: call agent_result for each completed worker you need to synthesize.`);
	} else if (result.reason === "relay_raised") {
		const count = result.newRelays?.length ?? 0;
		lines.push(`${count} new relay question(s) raised — answer via agent_message, then call wait_for_agents again to resume.`);
		appendWaitRelayGuidance(lines, result);
	} else if (result.reason === "timeout") {
		lines.push("Wait timed out; some workers may still be running.", `${TOOL_SECTION_LABELS.nextAction}: inspect statuses or call wait_for_agents again with the same workerIds.`);
	} else {
		lines.push("Wait aborted by the caller before all workers reached terminal status.", `${TOOL_SECTION_LABELS.nextAction}: inspect statuses with agent_status or cancel unwanted workers.`);
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
