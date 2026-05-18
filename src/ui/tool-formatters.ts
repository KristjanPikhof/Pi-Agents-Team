import type { WorkerRuntimeState } from "../types";
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
	readFiles: "Read files",
	changedFiles: "Changed files",
	risks: "Risks",
	nextAction: "Next",
	usage: "Usage",
	context: "Context",
	finalAnswer: "--- Final answer (from worker's <final_answer> block) ---",
	latestAssistantText: "--- Latest assistant text ---",
} as const;

const FINAL_ANSWER_MISSING_MESSAGE =
	"No <final_answer> block extracted yet. If the worker is idle and this is empty, it did not follow the final-answer contract — re-delegate or steer it with: `Please wrap your final deliverable in <final_answer>…</final_answer> tags.`";

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

function appendWorkerSummary(lines: string[], worker: WorkerRuntimeState, limits?: { readFiles: number; changedFiles: number; risks: number }): void {
	const summary = worker.lastSummary;
	if (!summary) return;
	if (summary.headline) lines.push(`${TOOL_SECTION_LABELS.summary}: ${summary.headline}`);
	if (summary.readFiles.length) lines.push(`${TOOL_SECTION_LABELS.readFiles}: ${limits ? truncateList(summary.readFiles, limits.readFiles) : summary.readFiles.join(", ")}`);
	if (summary.changedFiles.length) lines.push(`${TOOL_SECTION_LABELS.changedFiles}: ${limits ? truncateList(summary.changedFiles, limits.changedFiles) : summary.changedFiles.join(", ")}`);
	if (summary.risks.length) lines.push(`${TOOL_SECTION_LABELS.risks}: ${limits ? truncateList(summary.risks, limits.risks) : summary.risks.join("; ")}`);
	if (summary.nextRecommendation) lines.push(`${TOOL_SECTION_LABELS.nextAction}: ${summary.nextRecommendation}`);
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
	if (worker.finalAnswer && worker.finalAnswer.trim()) {
		lines.push("", TOOL_SECTION_LABELS.finalAnswer, worker.finalAnswer.trim());
	} else {
		lines.push("", FINAL_ANSWER_MISSING_MESSAGE);
	}
}

export function formatWorkerListItem(worker: WorkerRuntimeState): string {
	const parts = [`${worker.workerId} (${worker.profileName})`, `status=${worker.status}`];
	const contextBudget = formatContextBudget(worker.usage);
	if (contextBudget) parts.push(contextBudget);
	if (worker.currentTask?.title) parts.push(`task=${worker.currentTask.title}`);
	if (worker.lastToolName && worker.status === "running") parts.push(`tool=${worker.lastToolName}`);
	if (worker.lastSummary?.headline) {
		const tag = worker.status === "running" ? "interim" : "summary";
		parts.push(`${tag}=${worker.lastSummary.headline}`);
	}
	if (worker.pendingRelayQuestions.length > 0) parts.push(`relays=${worker.pendingRelayQuestions.length}`);
	return parts.join(" · ");
}

export function formatWorkers(workers: readonly WorkerRuntimeState[]): string {
	if (workers.length === 0) return "No active or persisted workers.";
	return workers.map((worker) => `- ${formatWorkerListItem(worker)}`).join("\n");
}

export function formatDelegateTaskResult(title: string, worker: Pick<WorkerRuntimeState, "workerId" | "profileName">): string {
	return `Delegated ${title} to ${worker.profileName} as ${worker.workerId}.`;
}

export function formatWaitForAgentsResult(result: WaitForAgentsFormatInput): string {
	if (result.reason === "no_workers") return "No tracked workers to wait on.";

	let header: string;
	if (result.reason === "all_terminal") {
		header = `All ${result.workers.length} worker(s) reached terminal status.`;
	} else if (result.reason === "relay_raised") {
		const count = result.newRelays?.length ?? 0;
		header = `${count} new relay question(s) raised — answer via agent_message, then call wait_for_agents again to resume.`;
	} else if (result.reason === "timeout") {
		header = "Wait timed out; some workers may still be running.";
	} else {
		header = "Wait aborted.";
	}
	const relayLines = (result.newRelays ?? []).map(
		(relay) => `  ! ${relay.workerId} (${relay.profileName}) [${relay.urgency}] ${relay.question}`,
	);
	return [header, ...relayLines, formatWorkers(result.workers)].join("\n");
}

export function formatWorkerCompact(worker: WorkerRuntimeState): string {
	const lines = [
		`${TOOL_SECTION_LABELS.worker}: ${worker.workerId} (${worker.profileName})`,
		`${TOOL_SECTION_LABELS.status}: ${worker.status}`,
	];
	if (worker.currentTask?.title) lines.push(`${TOOL_SECTION_LABELS.task}: ${worker.currentTask.title}`);
	if (worker.error) lines.push(`Error: ${worker.error}`);

	appendWorkerSummary(lines, worker, { readFiles: 10, changedFiles: 10, risks: 5 });
	appendRelayQuestions(lines, worker);
	appendUsageAndContext(lines, worker, false);
	appendFinalAnswer(lines, worker);
	return lines.join("\n");
}

export function formatWorkerDetail(worker: WorkerRuntimeState, options: FormatWorkerDetailOptions = {}): string {
	const lines = [
		`${TOOL_SECTION_LABELS.worker}: ${worker.workerId}`,
	];
	if (options.includeProfileLine !== false) lines.push(`${TOOL_SECTION_LABELS.profile}: ${worker.profileName}`);
	lines.push(`${TOOL_SECTION_LABELS.status}: ${worker.status}`);
	if (worker.currentTask?.title) lines.push(`${TOOL_SECTION_LABELS.task}: ${worker.currentTask.title}`);
	if (worker.currentTask?.goal) lines.push(`${TOOL_SECTION_LABELS.goal}: ${worker.currentTask.goal}`);
	if (worker.currentTask?.cwd) lines.push(`${TOOL_SECTION_LABELS.cwd}: ${worker.currentTask.cwd}`);
	if (worker.currentTask?.pathScope?.roots.length) {
		const mode = worker.currentTask.pathScope.allowWrite ? "read/write" : "read-only";
		lines.push(`${TOOL_SECTION_LABELS.pathScope}: ${mode} ${worker.currentTask.pathScope.roots.join(", ")}`);
	}
	if (worker.lastToolName) lines.push(`Last tool: ${worker.lastToolName}`);
	if (worker.error) lines.push(`Error: ${worker.error}`);

	appendWorkerSummary(lines, worker);
	appendRelayQuestions(lines, worker);
	lines.push("");
	appendUsageAndContext(lines, worker, options.compactUsage ?? true);
	appendFinalAnswer(lines, worker);

	if (options.transcript && options.transcript.trim()) {
		lines.push("", TOOL_SECTION_LABELS.latestAssistantText, options.transcript.trim());
	}

	return lines.join("\n");
}
