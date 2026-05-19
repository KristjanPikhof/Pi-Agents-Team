import { truncateToWidth, visibleWidth as measureVisibleWidth } from "@earendil-works/pi-tui";
import type { DelegatedTaskInput, TeamPathScope, WorkerRuntimeState, WorkerStatus } from "../types";
import { formatProfileLabel, formatWorkerDisplayId, formatWorkerLabel, formatWorkerStatusLabel, formatWorkerToolLabel } from "./display-grammar";
import { formatContextBudget } from "./usage-format";

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
	warning: "Warning",
	finalAnswerNote: "Result note",
	finalAnswer: "Result",
	latestAssistantText: "Latest assistant text",
} as const;

const FINAL_ANSWER_MISSING_MESSAGE = "No <final_answer> block extracted yet.";
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DEFAULT_TRUNCATE_WIDTH = 120;
const SUMMARY_ITEM_LIMIT = 5;

export const TOOL_SECTION_ORDER = [
	TOOL_SECTION_LABELS.lifecycle,
	TOOL_SECTION_LABELS.status,
	TOOL_SECTION_LABELS.relayQuestions,
	TOOL_SECTION_LABELS.summary,
	TOOL_SECTION_LABELS.readFiles,
	TOOL_SECTION_LABELS.changedFiles,
	TOOL_SECTION_LABELS.risks,
	TOOL_SECTION_LABELS.nextAction,
	TOOL_SECTION_LABELS.finalAnswerNote,
	TOOL_SECTION_LABELS.finalAnswer,
] as const;

export const WORKER_STATUS_SCAN_ORDER: readonly WorkerStatus[] = [
	"error",
	"aborted",
	"exited",
	"waiting_followup",
	"running",
	"starting",
	"created",
	"completed",
	"idle",
];

export const FINAL_ANSWER_METADATA_LABELS = {
	headline: TOOL_SECTION_LABELS.summary,
	filesRead: TOOL_SECTION_LABELS.readFiles,
	filesChanged: TOOL_SECTION_LABELS.changedFiles,
	risks: TOOL_SECTION_LABELS.risks,
	nextRecommendation: TOOL_SECTION_LABELS.nextAction,
	relayQuestions: TOOL_SECTION_LABELS.relayQuestions,
	resultNote: TOOL_SECTION_LABELS.finalAnswerNote,
	result: TOOL_SECTION_LABELS.finalAnswer,
} as const;

export interface ScanFriendlyTextOptions {
	maxWidth?: number;
	placeholder?: string;
}

export interface ScanSectionInput {
	label: string;
	value?: string | number | boolean | null;
	items?: readonly (string | number | boolean | null | undefined)[];
	maxWidth?: number;
	empty?: string;
}

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

export function visibleWidth(text: string): number {
	return measureVisibleWidth(text);
}

export function truncateScanValue(value: string, options: ScanFriendlyTextOptions = {}): string {
	const maxWidth = options.maxWidth ?? DEFAULT_TRUNCATE_WIDTH;
	const placeholder = options.placeholder ?? "";
	const normalized = value.replace(/\s+/g, " ").trim() || placeholder;
	const plain = normalized.replace(ANSI_PATTERN, "");
	if (maxWidth <= 0 || measureVisibleWidth(plain) <= maxWidth) return plain;
	return truncateToWidth(plain, maxWidth, "…").trimEnd();
}

export function formatScanSection(section: ScanSectionInput): string | undefined {
	const maxWidth = section.maxWidth ?? DEFAULT_TRUNCATE_WIDTH;
	const values = section.items
		? section.items.map((item) => truncateScanValue(String(item ?? ""), { maxWidth })).filter(Boolean)
		: [truncateScanValue(String(section.value ?? ""), { maxWidth, placeholder: section.empty })].filter(Boolean);
	if (values.length === 0) return undefined;
	if (section.items) return [`${section.label}:`, ...values.map((value) => `- ${value}`)].join("\n");
	return `${section.label}: ${values[0]}`;
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

function appendWorkerCompactHeader(lines: string[], worker: WorkerRuntimeState): void {
	lines.push(formatWorkerResultTitle(worker));
	if (worker.currentTask?.title) lines.push(`${TOOL_SECTION_LABELS.task}: ${worker.currentTask.title}`);
	lines.push(`${TOOL_SECTION_LABELS.status}: ${worker.status} (${formatWorkerStatusLabel(worker)})`);
	if (worker.error) lines.push(`${TOOL_SECTION_LABELS.error}: ${worker.error}`);
}

function coerceSummaryItems(items: unknown): string[] {
	return Array.isArray(items) ? items.map((item) => String(item)).filter(Boolean) : [];
}

function compactSummaryItems(items: unknown): string[] {
	const normalized = coerceSummaryItems(items);
	const visible = normalized.slice(0, SUMMARY_ITEM_LIMIT);
	if (normalized.length > SUMMARY_ITEM_LIMIT) return [...visible, `+${normalized.length - SUMMARY_ITEM_LIMIT} more`];
	return [...visible];
}

function appendWorkerSummary(lines: string[], worker: WorkerRuntimeState): void {
	const summary = worker.lastSummary;
	if (!summary) return;
	const sections = [
		formatScanSection({ label: TOOL_SECTION_LABELS.summary, value: summary.headline }),
		formatScanSection({ label: TOOL_SECTION_LABELS.readFiles, items: compactSummaryItems(summary.readFiles) }),
		formatScanSection({ label: TOOL_SECTION_LABELS.changedFiles, items: compactSummaryItems(summary.changedFiles) }),
		formatScanSection({ label: TOOL_SECTION_LABELS.risks, items: compactSummaryItems(summary.risks) }),
		formatScanSection({ label: TOOL_SECTION_LABELS.nextAction, value: summary.nextRecommendation }),
	].filter((section): section is string => Boolean(section));
	if (sections.length > 0) lines.push("", ...sections);
}

function appendRelayQuestions(lines: string[], worker: WorkerRuntimeState): void {
	if (worker.pendingRelayQuestions.length === 0) return;
	lines.push("", `${TOOL_SECTION_LABELS.relayQuestions}:`);
	for (const relay of worker.pendingRelayQuestions) {
		lines.push(`- [${relay.urgency}] ${relay.question}`);
		lines.push(`  assumption: ${relay.assumption}`);
	}
}

function appendFinalAnswer(lines: string[], worker: WorkerRuntimeState, options: { includeResultNotes?: boolean } = {}): void {
	const finalAnswer = worker.finalAnswer?.trim();
	if (!finalAnswer) {
		if (options.includeResultNotes) lines.push("", `${TOOL_SECTION_LABELS.finalAnswerNote}: ${FINAL_ANSWER_MISSING_MESSAGE}`);
		lines.push("", `${TOOL_SECTION_LABELS.finalAnswer}:`, FINAL_ANSWER_MISSING_MESSAGE);
		return;
	}
	if (options.includeResultNotes && visibleWidth(finalAnswer) < 20) lines.push("", `${TOOL_SECTION_LABELS.finalAnswerNote}: final_answer is very short; verify it is complete.`);
	lines.push("", `${TOOL_SECTION_LABELS.finalAnswer}:`, finalAnswer);
}

export function formatWorkerListItem(worker: WorkerRuntimeState): string {
	const parts = [formatWorkerToolLabel(worker), `status=${worker.status} (${formatWorkerStatusLabel(worker)})`];
	if (worker.currentTask?.title) parts.push(`task=${worker.currentTask.title}`);
	const contextBudget = formatContextBudget(worker.usage);
	if (contextBudget) parts.push(contextBudget);
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
	warnings?: readonly string[];
}

function formatPathScope(scope: TeamPathScope): string {
	const mode = scope.allowWrite ? "write allowed" : "read-only";
	const roots = truncateList(scope.roots, 4) || "no roots";
	const readPolicy = scope.allowReadOutsideRoots ? "read outside scope allowed" : "read restricted to scope";
	return `${mode}: ${roots} (${readPolicy})`;
}

export function formatDelegateTaskResult(result: DelegateTaskFormatInput): string {
	const task = result.task ?? result.worker.currentTask;
	const title = task?.title ?? "delegated task";
	const taskLabel = task?.taskId ? `${title} (${task.taskId})` : title;
	const lines = [`${TOOL_SECTION_LABELS.task}: ${taskLabel}`];
	if (task?.cwd) lines.push(`${TOOL_SECTION_LABELS.cwd}: ${task.cwd}`);
	if (task?.pathScope) lines.push(`${TOOL_SECTION_LABELS.pathScope}: ${formatPathScope(task.pathScope)}`);
	const warnings = result.warnings ?? [];
	if (warnings.length > 0) lines.push(formatScanSection({ label: TOOL_SECTION_LABELS.warning, items: warnings }) ?? "");
	lines.push(`${TOOL_SECTION_LABELS.nextAction}: wait for ${result.worker.workerId}.`);
	return lines.filter(Boolean).join("\n");
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
		lines.push(`${index + 1}. ${formatProfileLabel(relay.profileName)} ${formatWorkerDisplayId(relay.workerId)} [${relay.urgency}]`);
		lines.push(`   question: ${relay.question}`);
		lines.push(`   respond: agent_message workerId=${JSON.stringify(relay.workerId)} message=<answer>`);
	}
}

export function formatWaitForAgentsResult(result: WaitForAgentsFormatInput): string {
	if (result.reason === "no_workers") {
		return [
			`${TOOL_SECTION_LABELS.wait}: no_workers`,
			`${TOOL_SECTION_LABELS.status}: no agents tracked`,
			`${TOOL_SECTION_LABELS.nextAction}: delegate a task first.`,
		].join("\n");
	}

	const lines: string[] = [`${TOOL_SECTION_LABELS.wait}: ${result.reason}`];
	if (result.reason === "all_terminal") {
		lines.push(
			`${TOOL_SECTION_LABELS.status}: ${result.workers.length} agent(s) finished or stopped`,
			`${TOOL_SECTION_LABELS.nextAction}: read results with agent_result for ${formatWaitWorkerIds(result.workers)}.`,
		);
	} else if (result.reason === "relay_raised") {
		const count = result.newRelays?.length ?? 0;
		lines.push(`${TOOL_SECTION_LABELS.status}: ${count} relay question(s) need reply`);
		appendWaitRelayGuidance(lines, result);
		lines.push(`${TOOL_SECTION_LABELS.nextAction}: answer relay(s) with agent_message, then wait_for_agents for ${formatWaitWorkerIds(result.workers)}.`);
	} else if (result.reason === "timeout") {
		lines.push(
			`${TOOL_SECTION_LABELS.status}: still waiting for non-terminal agent(s)`,
			`${TOOL_SECTION_LABELS.nextAction}: call wait_for_agents again for ${formatWaitWorkerIds(result.workers)} or inspect agent_status.`,
		);
	} else {
		lines.push(
			`${TOOL_SECTION_LABELS.status}: wait cancelled before all agents finished`,
			`${TOOL_SECTION_LABELS.nextAction}: inspect agent_status or cancel unwanted agents.`,
		);
	}
	appendWaitWorkers(lines, result.workers);
	return lines.join("\n");
}

export function formatWorkerCompact(worker: WorkerRuntimeState): string {
	const lines: string[] = [];
	appendWorkerCompactHeader(lines, worker);
	appendRelayQuestions(lines, worker);
	appendWorkerSummary(lines, worker);
	appendFinalAnswer(lines, worker, { includeResultNotes: true });
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
