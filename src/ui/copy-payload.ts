import type { WorkerActivityEvent, WorkerConsoleEvent } from "../runtime/worker-manager.js";
import type { WorkerRuntimeState } from "../types.js";
import { parseFinalAnswerSummaryFields } from "../runtime/final-answer.js";
import { sanitizeTerminalText } from "./theme.js";
import { formatRetainedTranscript } from "./transcript-retention.js";
import { hasCacheUsage } from "./usage-format.js";

function formatTs(ts: number): string {
	const date = new Date(ts);
	return date.toISOString();
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `[${formatTs(event.ts)}] [${event.kind}] ${sanitizeTerminalText(event.text)}`;
}

function formatFinalAnswerFields(fields: WorkerActivityEvent["finalSummaryFields"] | undefined, summary?: string): string[] {
	if (!fields || Object.keys(fields).length === 0) return summary ? [`  ${summary}`] : [];
	const lines: string[] = [];
	if (fields.headline) lines.push(`  Headline: ${sanitizeTerminalText(fields.headline)}`);
	for (const risk of fields.risks ?? []) lines.push(`  Risks: ${sanitizeTerminalText(risk)}`);
	if (fields.nextRecommendation) lines.push(`  Next: ${sanitizeTerminalText(fields.nextRecommendation)}`);
	return lines;
}

function formatActivityEvent(event: WorkerActivityEvent): string[] {
	const label = sanitizeTerminalText(event.label);
	const commandText = sanitizeTerminalText(event.command ?? event.summary ?? label.replace(/^Ran\s+/, ""));
	const toolName = event.toolName ? sanitizeTerminalText(event.toolName) : undefined;
	const bulletLabel = event.actionKind === "command"
		? `• Ran ${commandText.replace(/^Ran\s+/, "")}`
		: event.actionKind === "tool"
			? `• ${label.startsWith("Used ") ? label : `Used ${toolName ?? label}`}`
			: `• ${label}`;
	const lines = [bulletLabel];
	if (event.actionKind === "final_summary") {
		lines.push(...formatFinalAnswerFields(event.finalSummaryFields, event.summary));
	} else if (event.summary && event.actionKind !== "command") {
		lines.push(`  ${sanitizeTerminalText(event.summary)}`);
	}
	if (event.outputSnippet) {
		for (const line of sanitizeTerminalText(event.outputSnippet).split("\n")) lines.push(`  ${line}`);
	}
	if ((event.hiddenLineCount ?? 0) > 0) lines.push(`  … +${event.hiddenLineCount} lines hidden`);
	return lines;
}

function extractHiddenLineCount(text: string): number | undefined {
	const match = /… \+(\d+) lines hidden/.exec(text);
	return match ? Number(match[1]) : undefined;
}

function stripHiddenLineCount(text: string): string {
	return text.replace(/\n?… \+\d+ lines hidden/g, "").trim();
}

function extractToolOutput(text: string): string | undefined {
	const output = text.includes("→") ? text.slice(text.indexOf("→") + 1).trim() : text.trim();
	const stripped = stripHiddenLineCount(output);
	return stripped || undefined;
}

function synthesizeActivity(
	worker: WorkerRuntimeState,
	consoleEvents: WorkerConsoleEvent[] | undefined,
): WorkerActivityEvent[] {
	const activity: WorkerActivityEvent[] = [];
	let id = 0;
	const events = consoleEvents ?? [];
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (event.kind === "tool_start") {
			const next = events.slice(index + 1).find((candidate) => candidate.kind === "tool_end" && candidate.ts >= event.ts);
			activity.push({
				id: `copy:${id++}`,
				ts: event.ts,
				updatedAt: next?.ts ?? event.ts,
				actionKind: "command",
				status: next ? "completed" : "started",
				label: `Ran ${sanitizeTerminalText(event.text)}`,
				summary: sanitizeTerminalText(event.text),
				command: sanitizeTerminalText(event.text),
				...(next ? { outputSnippet: extractToolOutput(next.text) } : {}),
				...(next ? { hiddenLineCount: extractHiddenLineCount(next.text) } : {}),
				sourceEvent: "worker_text_flush",
			});
		} else if (event.kind === "error" || event.kind === "exit" || event.kind === "queue") {
			activity.push({
				id: `copy:${id++}`,
				ts: event.ts,
				updatedAt: event.ts,
				actionKind: event.kind,
				status: event.kind === "error" ? "error" : "info",
				label: event.kind === "error" ? "Worker error" : event.kind === "exit" ? "Worker exited" : "Messages queued",
				summary: sanitizeTerminalText(event.text),
				sourceEvent: "worker_text_flush",
			});
		}
	}
	if (worker.finalAnswer) {
		const fields = parseFinalAnswerSummaryFields(sanitizeTerminalText(worker.finalAnswer));
		activity.push({
			id: `copy:${id++}`,
			ts: worker.lastEventAt,
			updatedAt: worker.lastEventAt,
			actionKind: "final_summary",
			status: "completed",
			label: "Final answer",
			summary: sanitizeTerminalText(worker.finalAnswer).replace(/\s+/g, " ").trim(),
			sourceEvent: "worker_text_flush",
			finalSummaryFields: fields,
		});
	}
	return activity.sort((a, b) => a.ts - b.ts || a.updatedAt - b.updatedAt);
}

export function buildCopyPayload(
	worker: WorkerRuntimeState,
	transcript: string | undefined,
	consoleEvents: WorkerConsoleEvent[] | undefined,
	activityEvents?: WorkerActivityEvent[],
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
	lines.push(sanitizeTerminalText(worker.finalAnswer ?? "").trim() || "(no <final_answer> block produced)");

	if (worker.lastSummary) {
		lines.push("", "## Supporting artifacts");
		if (worker.lastSummary.headline) lines.push(`headline: ${sanitizeTerminalText(worker.lastSummary.headline)}`);
		if (worker.lastSummary.changedFiles.length) {
			lines.push("changed_files:");
			for (const f of worker.lastSummary.changedFiles) lines.push(`  - ${sanitizeTerminalText(f)}`);
		}
		if (worker.lastSummary.readFiles.length) {
			lines.push("read_files:");
			for (const f of worker.lastSummary.readFiles) lines.push(`  - ${sanitizeTerminalText(f)}`);
		}
		if (worker.lastSummary.risks.length) {
			lines.push("risks:");
			for (const r of worker.lastSummary.risks) lines.push(`  - ${sanitizeTerminalText(r)}`);
		}
		if (worker.lastSummary.nextRecommendation) lines.push(`next_recommendation: ${sanitizeTerminalText(worker.lastSummary.nextRecommendation)}`);
	}

	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("", "## Pending relay questions");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${sanitizeTerminalText(relay.question)}`);
			lines.push(`  assumption: ${sanitizeTerminalText(relay.assumption)}`);
		}
	}

	const usageParts = [
		`turns=${worker.usage.turns}`,
		`input=${worker.usage.inputTokens}`,
		`output=${worker.usage.outputTokens}`,
		...(hasCacheUsage(worker.usage) ? [
			`cache_read=${worker.usage.cacheReadTokens}`,
			`cache_write=${worker.usage.cacheWriteTokens}`,
		] : []),
		`cost_usd=${worker.usage.costUsd.toFixed(4)}`,
	];
	lines.push(
		"",
		"## Usage",
		usageParts.join("  "),
	);

	if (worker.error) {
		lines.push("", "## Error", sanitizeTerminalText(worker.error));
	}

	lines.push("", "## Latest assistant text");
	lines.push(formatRetainedTranscript(transcript) || "(no assistant text captured)");

	const activity = activityEvents && activityEvents.length > 0 ? activityEvents : synthesizeActivity(worker, consoleEvents);
	lines.push("", "## Activity");
	if (activity.length === 0) {
		lines.push("(no activity captured)");
	} else {
		for (let index = 0; index < activity.length; index += 1) {
			if (index > 0) lines.push("");
			lines.push(...formatActivityEvent(activity[index]!));
		}
	}

	if (consoleEvents && consoleEvents.length > 0) {
		lines.push("", "## Console timeline (Raw)");
		for (const event of consoleEvents) {
			lines.push(formatConsoleEvent(event));
		}
	}

	return lines.join("\n");
}
