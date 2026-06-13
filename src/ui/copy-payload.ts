import type { WorkerActivityEvent, WorkerConsoleEvent } from "../runtime/worker-manager";
import type { WorkerRuntimeState } from "../types";
import { hasCacheUsage } from "./usage-format";

function formatTs(ts: number): string {
	const date = new Date(ts);
	return date.toISOString();
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `[${formatTs(event.ts)}] [${event.kind}] ${event.text}`;
}

function parseFinalAnswerFields(text: string): WorkerActivityEvent["finalSummaryFields"] {
	const headline = /^headline:\s*(.+)$/im.exec(text)?.[1]?.trim();
	const nextRecommendation = /^next_recommendation:\s*(.+)$/im.exec(text)?.[1]?.trim();
	const risksBlock = /^risks:\s*$(?<body>(?:\s*[-*]\s+.+\n?)*)/im.exec(text)?.groups?.body ?? "";
	const risks = risksBlock
		.split("\n")
		.map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
	return {
		...(headline ? { headline } : {}),
		...(risks.length > 0 ? { risks } : {}),
		...(nextRecommendation ? { nextRecommendation } : {}),
	};
}

function formatFinalAnswerFields(fields: WorkerActivityEvent["finalSummaryFields"] | undefined, summary?: string): string[] {
	if (!fields || Object.keys(fields).length === 0) return summary ? [`  ${summary}`] : [];
	const lines: string[] = [];
	if (fields.headline) lines.push(`  Headline: ${fields.headline}`);
	for (const risk of fields.risks ?? []) lines.push(`  Risks: ${risk}`);
	if (fields.nextRecommendation) lines.push(`  Next: ${fields.nextRecommendation}`);
	return lines;
}

function formatActivityEvent(event: WorkerActivityEvent): string[] {
	const bulletLabel = event.actionKind === "command"
		? `• Ran ${event.command ?? event.summary ?? event.label.replace(/^Ran\s+/, "")}`
		: event.actionKind === "tool"
			? `• ${event.label.startsWith("Used ") ? event.label : `Used ${event.toolName ?? event.label}`}`
			: `• ${event.label}`;
	const lines = [bulletLabel];
	if (event.actionKind === "final_summary") {
		lines.push(...formatFinalAnswerFields(event.finalSummaryFields, event.summary));
	} else if (event.summary && event.actionKind !== "command") {
		lines.push(`  ${event.summary}`);
	}
	if (event.outputSnippet) {
		for (const line of event.outputSnippet.replace(/\r/g, "").split("\n")) lines.push(`  ${line}`);
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
				label: `Ran ${event.text}`,
				summary: event.text,
				command: event.text,
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
				summary: event.text,
				sourceEvent: "worker_text_flush",
			});
		}
	}
	if (worker.finalAnswer) {
		const fields = parseFinalAnswerFields(worker.finalAnswer);
		activity.push({
			id: `copy:${id++}`,
			ts: worker.lastEventAt,
			updatedAt: worker.lastEventAt,
			actionKind: "final_summary",
			status: "completed",
			label: "Final answer",
			summary: worker.finalAnswer.replace(/\s+/g, " ").trim(),
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
		lines.push("", "## Error", worker.error);
	}

	lines.push("", "## Latest assistant text");
	lines.push(transcript?.trim() ?? "(no assistant text captured)");

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
		lines.push("", "## Raw console timeline");
		for (const event of consoleEvents) {
			lines.push(formatConsoleEvent(event));
		}
	}

	return lines.join("\n");
}
