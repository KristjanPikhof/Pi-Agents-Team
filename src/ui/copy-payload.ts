import type { WorkerConsoleEvent } from "../runtime/worker-manager";
import type { WorkerRuntimeState } from "../types";

function formatTs(ts: number): string {
	const date = new Date(ts);
	return date.toISOString();
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `[${formatTs(event.ts)}] [${event.kind}] ${event.text}`;
}

export function buildCopyPayload(
	worker: WorkerRuntimeState,
	transcript: string | undefined,
	consoleEvents: WorkerConsoleEvent[] | undefined,
): string {
	const lines = [
		`# Worker ${worker.workerId} · ${worker.profileName} · ${worker.status}`,
		`generated_at: ${new Date().toISOString()}`,
	];
	if (worker.currentTask) {
		lines.push("", "## Task");
		lines.push(`title: ${worker.currentTask.title}`);
		lines.push(`goal: ${worker.currentTask.goal}`);
		if (worker.currentTask.expectedOutput) lines.push(`expected_output: ${worker.currentTask.expectedOutput}`);
		if (worker.currentTask.contextHints.length > 0) {
			lines.push("context_hints:");
			for (const hint of worker.currentTask.contextHints) lines.push(`  - ${hint}`);
		}
		if (worker.currentTask.pathScope) {
			lines.push("path_scope:");
			for (const root of worker.currentTask.pathScope.roots) lines.push(`  - ${root}`);
		}
	}

	lines.push("", "## Final answer");
	lines.push(worker.finalAnswer?.trim() ?? "(no <final_answer> block produced)");

	if (worker.lastSummary) {
		lines.push("", "## Supporting artifacts");
		if (worker.lastSummary.headline) lines.push(`headline: ${worker.lastSummary.headline}`);
		if (worker.lastSummary.changedFiles.length) {
			lines.push("changed_files:");
			for (const f of worker.lastSummary.changedFiles) lines.push(`  - ${f}`);
		}
		if (worker.lastSummary.readFiles.length) {
			lines.push("read_files:");
			for (const f of worker.lastSummary.readFiles) lines.push(`  - ${f}`);
		}
		if (worker.lastSummary.risks.length) {
			lines.push("risks:");
			for (const r of worker.lastSummary.risks) lines.push(`  - ${r}`);
		}
		if (worker.lastSummary.nextRecommendation) lines.push(`next_recommendation: ${worker.lastSummary.nextRecommendation}`);
	}

	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("", "## Pending relay questions");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
			lines.push(`  assumption: ${relay.assumption}`);
		}
	}

	lines.push(
		"",
		"## Usage",
		`turns=${worker.usage.turns}  input=${worker.usage.inputTokens}  output=${worker.usage.outputTokens}  cache_read=${worker.usage.cacheReadTokens}  cache_write=${worker.usage.cacheWriteTokens}  cost_usd=${worker.usage.costUsd.toFixed(4)}`,
	);

	if (worker.error) {
		lines.push("", "## Error", worker.error);
	}

	lines.push("", "## Latest assistant text");
	lines.push(transcript?.trim() ?? "(no assistant text captured)");

	if (consoleEvents && consoleEvents.length > 0) {
		lines.push("", "## Console timeline");
		for (const event of consoleEvents) {
			lines.push(formatConsoleEvent(event));
		}
	}

	return lines.join("\n");
}
