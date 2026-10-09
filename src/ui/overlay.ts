import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { AgentMessageResult, TeamManager } from "../control-plane/team-manager.js";
import type { AssistantChunk, WorkerActivityEvent, WorkerConsoleEvent } from "../runtime/worker-manager.js";
import { extractFinalAnswer, parseFinalAnswerSummaryFields } from "../runtime/final-answer.js";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types.js";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage.js";
import { copyToClipboard } from "../util/clipboard.js";
import { buildCopyPayload } from "./copy-payload.js";
import { buildRosterSections, buildTeamDashboardText, type WorkerAttentionGroup } from "./dashboard.js";
import { formatRetainedTranscript } from "./transcript-retention.js";
import { formatCompactTokenCount } from "./usage-format.js";
import { formatWorkerLabel, formatWorkerStatusLabel, getWorkerAttentionPriority, getWorkerPrimaryAction } from "./display-grammar.js";
import { formatAgentMessageResult } from "./tool-formatters.js";
import { FRAME, stripAnsi, sanitizeTerminalText, fallbackPalette, themedPalette, type ThemedPalette } from "./theme.js";

// The overlay is a single-instance custom component. Styling helpers delegate
// to a mutable palette so the Pi Theme object supplied by ctx.ui.custom can be
// applied, invalidated, and rebuilt without threading a palette through every
// standalone helper signature.
let currentPalette: ThemedPalette = fallbackPalette;

const fallbackTheme = {
	fg(role: string, text: string): string {
		if (!text) return text;
		if (role === "accent") return fallbackPalette.accent(text);
		if (role === "success") return fallbackPalette.success(text);
		if (role === "warning") return fallbackPalette.warning(text);
		if (role === "error") return fallbackPalette.danger(text);
		if (role === "dim" || role === "muted" || role === "border") return fallbackPalette.muted(text);
		return text;
	},
	bold: fallbackPalette.bold,
	inverse: fallbackPalette.inverse,
} as Theme;

function isUsableTheme(theme?: Theme): theme is Theme {
	return !!theme
		&& typeof (theme as Theme).fg === "function"
		&& typeof (theme as Theme).bold === "function"
		&& typeof (theme as Theme).inverse === "function";
}

function resolveTheme(theme?: Theme): Theme {
	return isUsableTheme(theme) ? theme : fallbackTheme;
}

const bold = (text: string): string => currentPalette.bold(text);
const dim = (text: string): string => currentPalette.dim(text);
const muted = (text: string): string => currentPalette.muted(text);
const accent = (text: string): string => currentPalette.accent(text);
const accentBold = (text: string): string => currentPalette.accentBold(text);
const success = (text: string): string => currentPalette.success(text);
const warning = (text: string): string => currentPalette.warning(text);
const warningBold = (text: string): string => currentPalette.warningBold(text);
const danger = (text: string): string => currentPalette.danger(text);
const dangerBold = (text: string): string => currentPalette.dangerBold(text);
const inverse = (text: string): string => currentPalette.inverse(text);

function setPalette(theme?: Theme): void {
	// The factory may hand us an empty object in tests; only switch to a real
	// Pi Theme when the expected callbacks are present so styling never breaks.
	if (isUsableTheme(theme)) {
		currentPalette = themedPalette(theme);
	} else {
		currentPalette = fallbackPalette;
	}
}

type OverlayTab = "workers" | "inspect" | "console" | "cost";
type ModalKind = "steer" | "message" | "new_task";

interface ModalState {
	kind: ModalKind;
	label: string;
	workerId?: string;
	input: LabeledInput;
}

interface DashboardState {
	tab: OverlayTab;
	selectedWorkerId?: string;
	inspectScroll: number;
	inspectFollow: boolean;
	inspectDetailsExpanded: boolean;
	workersScroll: number;
	consoleScroll: number;
	consoleFollow: boolean;
	consoleMode: "activity" | "raw";
	consoleSelectedActivityId?: string;
	consoleDetailsExpanded: boolean;
	consoleRevealSelection: boolean;
	helpExpanded: boolean;
	costScroll: number;
	modal?: ModalState;
}

interface RenderMetrics {
	listPageSize: number;
	bodyPageSize: number;
}

interface OverlayLikeTerminal {
	columns: number;
	rows: number;
}

interface OverlayLikeTui {
	terminal: OverlayLikeTerminal;
	requestRender?: (force?: boolean) => void;
}

// Pi-tui has no "push main pane" primitive: overlays float on top of the
// main chat. We compromise by anchoring to the top-right at 50% width and
// 90% height — bottom ~3 rows (chat input + footer) stay visible full-width.
export const TEAM_DASHBOARD_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "top-right",
	width: "50%",
	minWidth: 44,
	maxHeight: "90%",
	margin: 0,
};

// Must match TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight. Pi-tui clips returned
// lines to the overlay's pixel rectangle; if our render produces more rows
// than the panel can display, the bottom (frame + footer) gets cut. Compute
// our row budget from this constant, not from terminal rows directly.
const OVERLAY_HEIGHT_PCT = 0.9;

const TAB_ORDER: OverlayTab[] = ["workers", "inspect", "console", "cost"];
const TAB_LABELS: Record<OverlayTab, string> = {
	workers: "Workers",
	inspect: "Inspect",
	console: "Console",
	cost: "Cost",
};

const REUSABLE_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>(["idle", "waiting_followup"]);
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fieldLine(label: string, value: string): string {
	return `${muted(`${label}:`)} ${value}`;
}

function workerIdentity(worker: WorkerRuntimeState): string {
	return `${accentBold(sanitizeTerminalText(worker.workerId))} ${muted(sanitizeTerminalText(worker.profileName))}`;
}

function selectedRow(content: string, width: number, selected: boolean): string {
	const prefix = selected ? `${accentBold("> ")}` : "  ";
	const row = padToWidth(prefix + content, width);
	return selected ? currentPalette.selected(row) : row;
}

function alignedRow(cells: string[], widths: number[], rightAligned: number[] = []): string {
	return cells.map((cell, index) => {
		const padded = padToWidth(cell, widths[index]!);
		if (!rightAligned.includes(index)) return padded;
		return " ".repeat(Math.max(0, widths[index]! - visibleWidth(cell))) + truncateToWidth(cell, widths[index]!, "…");
	}).join("  ");
}

function previewRows(text: string, width: number, limit = 2): string[] {
	const contentWidth = Math.max(1, width - 4);
	const lines = wrapLines(text, contentWidth);
	if (lines.length > limit) lines[limit - 1] = truncateToWidth(lines[limit - 1]!, Math.max(1, contentWidth - 1), "") + muted("…");
	return lines.slice(0, limit).map((line) => `    ${line}`);
}

function teamSummaryLine(snapshot: PersistedTeamState, width: number): string {
	const count = Object.keys(snapshot.activeWorkers).length;
	const sections = buildRosterSections(snapshot);
	const labels: Record<WorkerAttentionGroup, string> = { needs_reply: "needs reply", needs_recovery: "needs recovery", in_progress: "working", completed_or_idle: "done" };
	const parts = sections.filter((section) => section.workers.length > 0).map((section) => colorForGroupBold(section.key)(`${section.workers.length} ${labels[section.key]}`));
	const attention = sections.filter((section) => section.key === "needs_reply" || section.key === "needs_recovery").reduce((sum, section) => sum + section.workers.length, 0);
	return firstFitting(width, [
		`${muted(`${count} workers`)}${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
		`${muted(`${count} workers`)} · ${attention ? warning(`${attention} need attention`) : muted("no action needed")}`,
		muted(`${count} workers`),
	]);
}

function usageFields(worker: WorkerRuntimeState, displayCost: boolean): string[] {
	const usage = worker.usage;
	const fields = [
		fieldLine("Tokens", `${formatCompactTokenCount(usage.inputTokens)} input · ${formatCompactTokenCount(usage.outputTokens)} output`),
		fieldLine("Turns", String(usage.turns)),
	];
	if (displayCost) fields.push(fieldLine("Cost", accentBold(`$${usage.costUsd.toFixed(4)}`)));
	if (usage.cacheReadTokens || usage.cacheWriteTokens) fields.push(fieldLine("Cache", `${formatCompactTokenCount(usage.cacheReadTokens)} read · ${formatCompactTokenCount(usage.cacheWriteTokens)} written`));
	if (usage.contextPercent !== undefined || usage.contextRemainingTokens !== undefined) {
		const parts: string[] = [];
		if (usage.contextPercent !== undefined) parts.push(`${usage.contextPercent}% used`);
		if (usage.contextWindow !== undefined) parts.push(`${formatCompactTokenCount(usage.contextWindow)} window`);
		if (usage.contextRemainingTokens !== undefined) parts.push(`${formatCompactTokenCount(usage.contextRemainingTokens)} remaining`);
		const value = parts.join(" · ");
		fields.push(fieldLine("Context", (usage.contextPercent ?? 0) >= 80 ? warning(value) : value));
	}
	return fields;
}

function hasClampedThinking(worker: WorkerRuntimeState): boolean {
	return worker.requestedThinkingLevel !== worker.effectiveThinkingLevel;
}

function formatThinking(worker: WorkerRuntimeState, palette: ThemedPalette): string {
	if (!hasClampedThinking(worker)) return worker.effectiveThinkingLevel;
	return palette.warning(`${worker.requestedThinkingLevel} -> ${worker.effectiveThinkingLevel} (clamped)`);
}

function compactActivityLine(event: WorkerActivityEvent): string | undefined {
	const label = sanitizeTerminalText(event.label);
	const command = event.command ? sanitizeTerminalText(event.command) : undefined;
	const summary = event.summary ? sanitizeTerminalText(event.summary) : undefined;
	const toolName = event.toolName ? sanitizeTerminalText(event.toolName) : undefined;
	if (event.actionKind === "command") return `• Ran ${command ?? summary ?? label.replace(/^Ran\s+/, "")}`;
	if (event.actionKind === "tool") return `• ${label.startsWith("Used ") ? label : `Used ${toolName ?? label}`}`;
	if (event.actionKind === "process" && summary) return `• ${label}: ${summary}`;
	if (event.actionKind === "final_summary") return "• Final answer produced";
	if (event.actionKind === "error" && summary) return `• Error: ${summary}`;
	return undefined;
}

function buildRecentActivityRows(
	worker: WorkerRuntimeState,
	transcript: string | undefined,
	consoleEvents: WorkerConsoleEvent[] | undefined,
	activityEvents: WorkerActivityEvent[] | undefined,
): string[] {
	const rows = (activityEvents && activityEvents.length > 0 ? activityEvents : synthesizeActivity([], consoleEvents ?? []))
		.map(compactActivityLine)
		.filter((line): line is string => Boolean(line))
		.filter((line, index, all) => all.indexOf(line) === index)
		.slice(-4);
	const transcriptLines = sanitizeTerminalText(transcript ?? "").trim().split("\n").filter(Boolean);
	const latestThinking = transcriptLines.length <= 3 ? transcriptLines.slice(-1)[0] : undefined;
	if (latestThinking && !rows.some((line) => line.includes(latestThinking))) rows.push(`• Thinking: ${latestThinking}`);
	if (worker.finalAnswer && !rows.includes("• Final answer produced")) rows.push("• Final answer produced");
	return rows;
}

function formatInspectStatus(worker: WorkerRuntimeState, palette: ThemedPalette): string {
	const label = worker.status;
	if (worker.pendingRelayQuestions.length > 0 || worker.status === "waiting_followup") return palette.warningBold(label);
	if (worker.status === "completed" || worker.status === "idle") return palette.successBold(label);
	if (worker.status === "error" || worker.status === "aborted") return palette.dangerBold(label);
	if (worker.status === "starting" || worker.status === "running") return palette.accentBold(label);
	return palette.muted(label);
}

function pushInspectBlock(lines: string[], label: string, body: string[], palette: ThemedPalette, badge?: string, options: { structured?: boolean } = {}): void {
	if (lines.length > 0) lines.push("");
	const badgeText = badge === "ok" ? palette.success("[ok]") : palette.muted(badge ? `[${badge}]` : "");
	lines.push(palette.accentBold(label) + (badge ? ` ${badgeText}` : ""));
	for (const line of body.length > 0 ? body : ["(none)"]) {
		const content = options.structured ? formatStructuredLine(line, classifyTextLine(line).kind) : line;
		lines.push(`  ${content}`);
	}
}

function pushInspectList(body: string[], label: string, values: string[], palette: ThemedPalette): void {
	if (values.length === 0) return;
	body.push(palette.dim(label));
	for (const value of values) body.push(`  ${value}`);
}

function buildInspectText(worker: WorkerRuntimeState, transcript: string | undefined, consoleEvents: WorkerConsoleEvent[] | undefined, activityEvents: WorkerActivityEvent[] | undefined, palette: ThemedPalette, displayCost: boolean, showDetails: boolean): string {
	const lines: string[] = [];
	const statusBody = [bold(sanitizeTerminalText(worker.currentTask?.title ?? "No assigned task"))];
	if (showDetails) statusBody.push(fieldLine("Role", sanitizeTerminalText(worker.profileName)));
	statusBody.push(fieldLine("Thinking", formatThinking(worker, palette)));
	if (worker.lastToolName) statusBody.push(fieldLine("Last tool", sanitizeTerminalText(worker.lastToolName)));
	pushInspectBlock(lines, "Status", statusBody, palette, formatInspectStatus(worker, palette));

	const operatorBody: string[] = [];
	if (worker.error) operatorBody.push(palette.danger(sanitizeTerminalText(worker.error)));
	for (const relay of worker.pendingRelayQuestions) {
		operatorBody.push(`${warningBold(`[${relay.urgency}]`)} ${sanitizeTerminalText(relay.question)}`);
		operatorBody.push(fieldLine("Assumption", sanitizeTerminalText(relay.assumption)));
	}
	if (operatorBody.length > 0) pushInspectBlock(lines, "Needs operator", operatorBody, palette, "attention");

	if (worker.lastSummary) {
		const summary = worker.lastSummary;
		const summaryBody = [sanitizeTerminalText(summary.headline)];
		pushInspectList(summaryBody, "Risks:", summary.risks.map((risk) => palette.warning(sanitizeTerminalText(risk))), palette);
		if (summary.nextRecommendation) summaryBody.push(fieldLine("Next", sanitizeTerminalText(summary.nextRecommendation)));
		if (showDetails) {
			pushInspectList(summaryBody, "Read files:", summary.readFiles.map(sanitizeTerminalText), palette);
			pushInspectList(summaryBody, "Changed files:", summary.changedFiles.map(sanitizeTerminalText), palette);
		} else if (summary.readFiles.length || summary.changedFiles.length) {
			summaryBody.push(palette.muted(`${summary.readFiles.length} files read · ${summary.changedFiles.length} changed · enter for details`));
		}
		pushInspectBlock(lines, "Summary", summaryBody, palette);
	}
	const finalAnswer = sanitizeTerminalText(worker.finalAnswer ?? "").trim();
	if (finalAnswer) pushInspectBlock(lines, "Final answer", finalAnswer.split("\n"), palette, "ok", { structured: true });
	else pushInspectBlock(lines, "Final answer", [palette.muted("Not available yet.")], palette);

	const recentActivity = buildRecentActivityRows(worker, transcript, consoleEvents, activityEvents);
	if (recentActivity.length > 0) pushInspectBlock(lines, "Recent activity", recentActivity, palette);
	pushInspectBlock(lines, "Usage", usageFields(worker, displayCost), palette);

	const taskBody: string[] = [];
	if (showDetails && worker.currentTask) {
		if (worker.currentTask.goal) taskBody.push(fieldLine("Goal", sanitizeTerminalText(worker.currentTask.goal)));
		if (worker.currentTask.expectedOutput) taskBody.push(fieldLine("Expected", sanitizeTerminalText(worker.currentTask.expectedOutput)));
		pushInspectList(taskBody, "Context:", worker.currentTask.contextHints.map(sanitizeTerminalText), palette);
		if (worker.currentTask.pathScope) pushInspectList(taskBody, "Path scope:", worker.currentTask.pathScope.roots.map(sanitizeTerminalText), palette);
	} else taskBody.push(palette.muted("Full instructions hidden · enter to show details."));
	pushInspectBlock(lines, "Task", taskBody, palette, showDetails ? "details" : "collapsed");

	const assistantText = showDetails ? formatRetainedTranscript(transcript) : "";
	const assistantBody = showDetails ? (assistantText || "No assistant text captured.").split("\n") : [palette.muted("Retained assistant text hidden · enter to show details.")];
	pushInspectBlock(lines, "Latest assistant text", assistantBody, palette, showDetails ? "tail" : "collapsed", { structured: true });
	return lines.join("\n");
}

function styleConsoleEventKind(event: WorkerConsoleEvent): string {
	const label = `[${event.kind}]`;
	if (event.kind === "error") return dangerBold(label);
	if (event.kind === "exit" || /\brecover(?:y|ed|ing)?\b/i.test(sanitizeTerminalText(event.text))) return warningBold(label);
	return dim(label);
}

function styleConsoleEventText(event: WorkerConsoleEvent): string {
	const text = sanitizeTerminalText(event.text);
	if (event.kind === "error") return danger(text);
	if (event.kind === "exit" || /\brecover(?:y|ed|ing)?\b/i.test(text)) return warning(text);
	return text;
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `${dim(`[${formatTimestamp(event.ts)}]`)} ${styleConsoleEventKind(event)} ${styleConsoleEventText(event)}`;
}

function formatFinalAnswerFields(fields: WorkerActivityEvent["finalSummaryFields"] | undefined, summary?: string): string[] {
	if (!fields || Object.keys(fields).length === 0) return summary ? [summary] : [];
	const lines: string[] = [];
	if (fields.headline) lines.push(`${bold("Headline:")} ${sanitizeTerminalText(fields.headline)}`);
	for (const risk of fields.risks ?? []) lines.push(`${bold("Risks:")} ${sanitizeTerminalText(risk)}`);
	if (fields.nextRecommendation) lines.push(`${bold("Next:")} ${sanitizeTerminalText(fields.nextRecommendation)}`);
	return lines;
}

function formatActivityStatus(status: WorkerActivityEvent["status"]): string {
	switch (status) {
		case "completed":
			return success("ok");
		case "error":
			return dangerBold("error");
		case "started":
			return accent("running");
		case "info":
			return muted("info");
	}
}

function activityName(event: WorkerActivityEvent): string {
	if (event.actionKind === "final_summary") return "Final answer";
	if (event.toolName) return sanitizeTerminalText(event.toolName);
	return event.actionKind === "command" ? "command" : sanitizeTerminalText(event.label);
}

function styleActivityName(event: WorkerActivityEvent, name: string): string {
	if (event.status === "error") return dangerBold(name);
	if (event.actionKind === "final_summary") return currentPalette.successBold(name);
	if (event.toolName === "read" || event.toolName === "ls") return bold(currentPalette.toolRead(name));
	if (event.toolName === "grep" || event.toolName === "find") return bold(currentPalette.toolSearch(name));
	if (event.actionKind === "command") return warningBold(name);
	if (event.actionKind === "tool") return accentBold(name);
	return muted(name);
}

function formatActivityDuration(event: WorkerActivityEvent): string | undefined {
	const durationMs = event.durationMs ?? (event.updatedAt > event.ts ? event.updatedAt - event.ts : undefined);
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	const seconds = durationMs / 1000;
	return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`;
}

function styleDiffStatLine(line: string): string {
	let styled = "";
	for (const char of line) {
		if (char === "+") styled += success(char);
		else if (char === "-") styled += danger(char);
		else styled += char;
	}
	return styled
		.replace(/(\d+\s+insertions?\(\+\))/g, (match) => success(match))
		.replace(/(\d+\s+deletions?\(-\))/g, (match) => danger(match));
}

function styleActivityOutputLine(line: string): string {
	const safeLine = sanitizeTerminalText(line);
	const plain = stripAnsi(safeLine);
	if (/^(diff --git|@@\s|index\s|\+\+\+\s|---\s)/.test(plain)) return accent(safeLine);
	if (/^\+(?!\+\+)/.test(plain)) return success(safeLine);
	if (/^-(?!---)/.test(plain)) return danger(safeLine);
	if (/\|\s*\d+\s+[+\-]+\s*$/.test(plain) || /\b\d+ files? changed\b/.test(plain)) return styleDiffStatLine(safeLine);
	return safeLine;
}

function formatActivityEvent(event: WorkerActivityEvent, width: number, nameWidth: number, selected: boolean, detailsExpanded: boolean, spinner: string): string[] {
	const command = event.command ? sanitizeTerminalText(event.command) : undefined;
	const summary = event.summary ? sanitizeTerminalText(event.summary) : undefined;
	const label = sanitizeTerminalText(event.label);
	const name = activityName(event);
	let description = summary && summary !== label ? summary : "";
	if (event.actionKind === "command") {
		description = command ?? summary ?? label.replace(/^Ran\s+/, "");
	} else if (event.actionKind === "final_summary") {
		description = event.finalSummaryFields?.headline ? sanitizeTerminalText(event.finalSummaryFields.headline) : summary ?? "ready";
	}
	const prefix = selected ? `${accentBold(">")} ` : "  ";
	const duration = formatActivityDuration(event);
	const trailing = event.status === "started" ? accent(spinner) : dim(duration ?? "");
	const suffix = `  ${padToWidth(`[${formatActivityStatus(event.status)}]`, 9)} ${padToWidth(trailing, 6)}`;
	const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
	const compactName = truncateToWidth(name.replace(/\s+/g, " "), Math.min(nameWidth, available), "…");
	const descriptionWidth = available - Math.min(nameWidth, available) - 2;
	const compactDescription = description && descriptionWidth > 1 ? `  ${truncateToWidth(description.replace(/\s+/g, " "), descriptionWidth, "…")}` : "";
	const styledName = styleActivityName(event, compactName);
	let header = padToWidth(`${prefix}${padToWidth(styledName, Math.min(nameWidth, available))}${muted(compactDescription)}`, width - visibleWidth(suffix)) + suffix;
	if (selected) header = currentPalette.selected(header);
	const lines = [truncateToWidth(header, width, "…")];
	if (!(selected && detailsExpanded) && event.status !== "error") return lines;

	const detailWidth = Math.max(1, width - 4);
	const details: string[] = [];
	if (event.actionKind === "final_summary") details.push(...formatFinalAnswerFields(event.finalSummaryFields, summary));
	else if (visibleWidth(description) > descriptionWidth || description.includes("\n")) details.push(command ? `$ ${command}` : description);
	if (visibleWidth(name) > visibleWidth(compactName)) details.unshift(name);
	if (event.outputSnippet) details.push(...sanitizeTerminalText(event.outputSnippet).split("\n"));
	if ((event.hiddenLineCount ?? 0) > 0) details.push(muted(`… +${event.hiddenLineCount} lines hidden`));
	for (const detail of details) {
		for (const line of wrapLines(detail, detailWidth)) lines.push(`    ${styleActivityOutputLine(line)}`);
	}
	return lines;
}

function synthesizeActivity(chunks: AssistantChunk[], consoleEvents: WorkerConsoleEvent[]): WorkerActivityEvent[] {
	const activity: WorkerActivityEvent[] = [];
	let id = 0;
	let pendingText = "";
	let pendingStart: AssistantChunk | undefined;
	let pendingEndTs = 0;
	const flushPendingText = () => {
		const summary = pendingText.trim();
		if (!summary || !pendingStart) {
			pendingText = "";
			pendingStart = undefined;
			pendingEndTs = 0;
			return;
		}
		activity.push({
			id: `chunk:${id++}`,
			ts: pendingStart.ts,
			updatedAt: pendingEndTs || pendingStart.ts,
			actionKind: "process",
			status: "info",
			label: "Thinking",
			summary,
			sourceEvent: "worker_text_flush",
		});
		pendingText = "";
		pendingStart = undefined;
		pendingEndTs = 0;
	};
	const separatorVariants = ["", "_", "-", " ", "\t", "\n"];
	const openTags = separatorVariants.map((separator) => `<final${separator}answer>`);
	const closeTags = separatorVariants.map((separator) => `</final${separator}answer>`);
	const findFirstTag = (text: string, tags: string[]): { index: number; tag: string } | undefined => {
		const lowerText = text.toLowerCase();
		let first: { index: number; tag: string } | undefined;
		for (const tag of tags) {
			const index = lowerText.indexOf(tag.toLowerCase());
			if (index >= 0 && (!first || index < first.index)) first = { index, tag: text.slice(index, index + tag.length) };
		}
		return first;
	};
	const longestTagPrefixSuffix = (text: string, tags: string[]): string => {
		const lowerText = text.toLowerCase();
		let longest = "";
		for (const tag of tags) {
			const lowerTag = tag.toLowerCase();
			for (let length = 1; length < lowerTag.length && length <= lowerText.length; length += 1) {
				if (length > longest.length && lowerText.endsWith(lowerTag.slice(0, length))) longest = text.slice(text.length - length);
			}
		}
		return longest;
	};
	let normalCarry = "";
	let normalCarryStart: AssistantChunk | undefined;
	let finalAnswerStart: AssistantChunk | undefined;
	let finalAnswerRaw = "";
	let finalAnswerEndTs = 0;
	let closeCarry = "";
	const appendPendingText = (text: string, chunk: AssistantChunk | undefined) => {
		if (!text || !chunk) return;
		pendingStart ??= chunk;
		pendingEndTs = chunk.ts;
		if (pendingText && !/\s$/.test(pendingText) && !/^\s/.test(text)) pendingText += "\n";
		pendingText += text;
	};
	const emitFinalAnswer = () => {
		const finalAnswer = extractFinalAnswer(finalAnswerRaw);
		if (!finalAnswer) {
			appendPendingText(finalAnswerRaw, finalAnswerStart);
		} else {
			activity.push({
				id: `chunk:${id++}`,
				ts: finalAnswerStart?.ts ?? finalAnswerEndTs,
				updatedAt: finalAnswerEndTs || finalAnswerStart?.ts || 0,
				actionKind: "final_summary",
				status: "completed",
				label: "Final answer",
				summary: finalAnswer.replace(/\s+/g, " ").trim(),
				sourceEvent: "worker_text_flush",
				finalSummaryFields: parseFinalAnswerSummaryFields(finalAnswer),
			});
		}
		finalAnswerStart = undefined;
		finalAnswerRaw = "";
		finalAnswerEndTs = 0;
		closeCarry = "";
	};
	for (const chunk of chunks) {
		let chunkText = sanitizeTerminalText(chunk.text);
		let chunkStart: AssistantChunk | undefined = chunk;
		while (chunkText.length > 0 || normalCarry || closeCarry) {
			if (finalAnswerStart) {
				const text = closeCarry + chunkText;
				const closeMatch = findFirstTag(text, closeTags);
				if (closeMatch) {
					finalAnswerRaw += text.slice(0, closeMatch.index) + closeMatch.tag;
					finalAnswerEndTs = chunk.ts;
					emitFinalAnswer();
					chunkText = text.slice(closeMatch.index + closeMatch.tag.length);
					closeCarry = "";
					chunkStart = chunk;
					continue;
				}
				const suffix = longestTagPrefixSuffix(text, closeTags);
				const safeText = suffix ? text.slice(0, -suffix.length) : text;
				finalAnswerRaw += safeText;
				if (safeText || suffix) finalAnswerEndTs = chunk.ts;
				closeCarry = suffix;
				break;
			}

			const text = normalCarry + chunkText;
			const textStart = normalCarry ? normalCarryStart : chunkStart;
			const openMatch = findFirstTag(text, openTags);
			if (openMatch) {
				appendPendingText(text.slice(0, openMatch.index), textStart);
				flushPendingText();
				finalAnswerStart = textStart ?? chunk;
				finalAnswerRaw = openMatch.tag;
				finalAnswerEndTs = chunk.ts;
				chunkText = text.slice(openMatch.index + openMatch.tag.length);
				normalCarry = "";
				normalCarryStart = undefined;
				chunkStart = chunk;
				continue;
			}
			const suffix = longestTagPrefixSuffix(text, openTags);
			const safeText = suffix ? text.slice(0, -suffix.length) : text;
			appendPendingText(safeText, textStart);
			normalCarry = suffix;
			normalCarryStart = suffix ? (textStart ?? chunk) : undefined;
			break;
		}
	}
	if (finalAnswerStart) appendPendingText(finalAnswerRaw + closeCarry, finalAnswerStart);
	else appendPendingText(normalCarry, normalCarryStart);
	flushPendingText();
	for (let index = 0; index < consoleEvents.length; index += 1) {
		const event = consoleEvents[index]!;
		if (event.kind === "tool_start") {
			const next = consoleEvents.slice(index + 1).find((candidate) => candidate.kind === "tool_end" && candidate.ts >= event.ts);
			const eventText = sanitizeTerminalText(event.text);
			const outputLines = next ? sanitizeTerminalText(next.text).split("\n") : [];
			const hiddenMatch = outputLines.find((line) => /… \+\d+ lines hidden/.test(line));
			activity.push({
				id: `event:${id++}`,
				ts: event.ts,
				updatedAt: next?.ts ?? event.ts,
				actionKind: "command",
				status: next?.kind === "tool_end" ? "completed" : "started",
				label: `Ran ${eventText}`,
				summary: eventText,
				command: eventText,
				outputSnippet: outputLines.filter((line) => !/… \+\d+ lines hidden/.test(line)).join("\n"),
				hiddenLineCount: hiddenMatch ? Number(/… \+(\d+) lines hidden/.exec(hiddenMatch)?.[1] ?? 0) : undefined,
				sourceEvent: "worker_text_flush",
			});
		} else if (event.kind === "error" || event.kind === "exit" || event.kind === "queue") {
			activity.push({
				id: `event:${id++}`,
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
	return activity.sort((a, b) => a.ts - b.ts || a.updatedAt - b.updatedAt);
}

function buildRawConsoleLines(
	worker: WorkerRuntimeState,
	chunks: AssistantChunk[],
	consoleEvents: WorkerConsoleEvent[],
): string[] {
	if (chunks.length === 0 && consoleEvents.length === 0) {
		return [`${worker.workerId} · ${worker.profileName} · ${worker.status}`, "", accentBold("— raw —"), "(no console activity yet)"];
	}
	const lines = [`${worker.workerId} · ${worker.profileName} · ${worker.status}  ·  chunks=${chunks.length}  events=${consoleEvents.length}  ·  raw`, "", accentBold("— raw —")];
	const entries = [
		...chunks.map((chunk) => ({ ts: chunk.ts, order: chunk.index, lines: [`[raw] assistant chunk #${chunk.index}`, ...sanitizeTerminalText(chunk.text).split("\n")] })),
		...consoleEvents.map((event, order) => ({ ts: event.ts, order, lines: sanitizeTerminalText(event.text).split("\n").map((line) => `[raw] ${event.kind} ${line}`) })),
	].sort((a, b) => a.ts - b.ts || a.order - b.order);
	for (const entry of entries) lines.push(...entry.lines);
	lines.push("", accentBold("— assistant —"));
	for (const chunk of chunks) lines.push(dim(`[${formatTimestamp(chunk.ts)}]`), ...sanitizeTerminalText(chunk.text).split("\n"));
	lines.push("", accentBold("— events —"));
	for (const event of consoleEvents) lines.push(formatConsoleEvent(event));
	return lines;
}

function getConsoleActivity(chunks: AssistantChunk[], consoleEvents: WorkerConsoleEvent[], activityEvents: WorkerActivityEvent[] | undefined): WorkerActivityEvent[] {
	return activityEvents && activityEvents.length > 0 ? activityEvents : synthesizeActivity(chunks, consoleEvents);
}

function buildActivityConsoleLines(activity: WorkerActivityEvent[], width: number, selectedId: string | undefined, detailsExpanded: boolean, spinner: string): { lines: string[]; selectedTop?: number; selectedBottom?: number } {
	const lines: string[] = [];
	let selectedTop: number | undefined;
	let selectedBottom: number | undefined;
	const nameWidth = Math.min(width >= 64 ? 20 : 12, Math.max(4, ...activity.map((event) => visibleWidth(activityName(event)))));
	for (const event of activity) {
		if (lines.length > 0) lines.push("");
		const selected = event.id === selectedId;
		if (selected) selectedTop = lines.length;
		lines.push(...formatActivityEvent(event, width, nameWidth, selected, detailsExpanded, spinner));
		if (selected) selectedBottom = lines.length;
	}
	if (lines.length === 0) lines.push(dim("No activity yet. Output will appear here."));
	return { lines, selectedTop, selectedBottom };
}

interface CostLayout {
	summary: string[];
	header: string[];
	rows: string[];
}

function buildCostLayout(state: PersistedTeamState, width: number, selectedId: string | undefined): CostLayout {
	const workers = getAttentionOrderedWorkerIds(state).map((id) => state.activeWorkers[id]!);
	const total = aggregateWorkerUsage(workers, state.prunedWorkerUsageTotals);
	const retained = state.prunedWorkerUsageTotals;
	const summary = [
		`${accentBold("Σ Agent total")}  ${bold(`$${total.costUsd.toFixed(4)}`)}`,
		muted(`${total.workers} workers · ${total.turns} turns · orchestrator excluded`),
		fieldLine("Tokens", `${formatCompactTokenCount(total.inputTokens)} input · ${formatCompactTokenCount(total.outputTokens)} output`),
	];
	const hasCache = total.cacheReadTokens !== 0 || total.cacheWriteTokens !== 0;
	if (hasCache) summary.push(fieldLine("Cache", `${formatCompactTokenCount(total.cacheReadTokens)} read · ${formatCompactTokenCount(total.cacheWriteTokens)} written`));
	if (hasWorkerUsage(retained)) summary.push(muted(`Includes ${retained.workers} pruned workers`));
	const entries = workers.map((worker) => ({ label: workerIdentity(worker), usage: worker.usage, selected: worker.workerId === selectedId }));
	if (hasWorkerUsage(retained)) entries.push({ label: muted(`Pruned (${retained.workers})`), usage: retained, selected: false });
	if (entries.length === 0) return { summary, header: [], rows: [muted("No tracked workers. Press [n] to delegate one.")] };
	const cellRows = entries.map((entry) => [
		entry.label, String(entry.usage.turns), formatCompactTokenCount(entry.usage.inputTokens), formatCompactTokenCount(entry.usage.outputTokens),
		...(hasCache ? [formatCompactTokenCount(entry.usage.cacheReadTokens), formatCompactTokenCount(entry.usage.cacheWriteTokens)] : []),
		accentBold(`$${entry.usage.costUsd.toFixed(4)}`),
	]);
	const labels = ["Worker", "Turns", "Input", "Output", ...(hasCache ? ["Cache read", "Cache write"] : []), "Cost"];
	const widths = labels.map((label, index) => Math.max(visibleWidth(label), ...cellRows.map((cells) => visibleWidth(cells[index]!))));
	widths[0] = Math.min(24, widths[0]!);
	const rightAligned = labels.map((_, index) => index).slice(1);
	const tableWidth = widths.reduce((sum, value) => sum + value, 0) + (widths.length - 1) * 2 + 2;
	const rows: string[] = [];
	if (tableWidth <= width) {
		for (const [index, entry] of entries.entries()) rows.push(selectedRow(alignedRow(cellRows[index]!, widths, rightAligned), width, entry.selected));
		return { summary, header: [muted("  " + alignedRow(labels, widths, rightAligned))], rows };
	}
	for (const entry of entries) {
		if (rows.length > 0) rows.push("");
		rows.push(selectedRow(entry.label, width, entry.selected));
		const fields = [fieldLine("Cost", accentBold(`$${entry.usage.costUsd.toFixed(4)}`)), fieldLine("Turns", String(entry.usage.turns)), fieldLine("Tokens", `${formatCompactTokenCount(entry.usage.inputTokens)} input · ${formatCompactTokenCount(entry.usage.outputTokens)} output`)];
		if (hasCache) fields.push(fieldLine("Cache", `${formatCompactTokenCount(entry.usage.cacheReadTokens)} read · ${formatCompactTokenCount(entry.usage.cacheWriteTokens)} written`));
		rows.push(...wrapLines(fields.map((field) => `    ${field}`).join("\n"), width));
	}
	return { summary, header: [], rows };
}

function getAttentionOrderedWorkerIds(state: PersistedTeamState): string[] {
	return buildRosterSections(state).flatMap((section) => section.workers.map((worker) => worker.workerId));
}

// Worker output frequently contains tabs and other control bytes whose
// visibleWidth (1) does not match the terminal's rendered width. Normalize
// before any measurement. ESC (0x1b) is preserved so our own ANSI styling
// (theme.ts) and pi-tui's ANSI-aware truncate keep working.
function sanitizeText(text: string): string {
	return text
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

type TextLineKind = "heading" | "list" | "table" | "separator" | "code" | "stack" | "plain";

interface TextLineShape {
	kind: TextLineKind;
	continuation: string;
}

// Strip our own styling before classifying so worker text wrapped in ANSI
// (e.g. a colored `# heading` from a tool) still matches the structural regexes.
function classifyTextLine(line: string): TextLineShape {
	const plain = stripAnsi(line);
	if (/^\s{4,}\S/.test(plain)) return { kind: "code", continuation: plain.match(/^\s*/)?.[0] ?? "" };
	if (/^\s{2,}\S/.test(plain)) return { kind: "plain", continuation: plain.match(/^\s*/)?.[0] ?? "" };
	if (/^\s*(?:at\s+\S|Caused by:|\.{3}\s+\d+\s+more|[A-Za-z_.$][\w.$<>]*Error:)/.test(plain)) return { kind: "stack", continuation: "    " };
	if (/^\s*#{1,6}\s+\S/.test(plain)) return { kind: "heading", continuation: dim("↳ ") };
	if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(plain)) {
		const marker = plain.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/)?.[0] ?? "";
		return { kind: "list", continuation: " ".repeat(visibleWidth(marker)) };
	}
	if (/^\s*\|.*\|\s*$/.test(plain)) return { kind: "table", continuation: dim("↳ ") };
	if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(plain) || /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(plain)) {
		return { kind: "separator", continuation: dim("↳ ") };
	}
	return { kind: "plain", continuation: dim("↳ ") };
}

function formatStructuredLine(line: string, kind: TextLineKind): string {
	switch (kind) {
		case "heading":
			return accentBold(line);
		case "separator":
			return dim(line);
		default:
			return line;
	}
}

function wrapTextLine(raw: string, width: number): string[] {
	const shape = classifyTextLine(raw);
	const first = formatStructuredLine(raw, shape.kind);
	if (visibleWidth(first) <= width) return [first];
	const out: string[] = [];
	let remaining = raw;
	let prefix = "";
	let guard = 0;
	while (visibleWidth(prefix + remaining) > width && guard < 1000) {
		const available = Math.max(1, width - visibleWidth(prefix));
		let head = truncateToWidth(remaining, available, "");
		if (shape.kind !== "code" && visibleWidth(head) === available) {
			const breakAt = head.search(/\s+\S*$/);
			if (breakAt > Math.floor(available * 0.45)) head = head.slice(0, breakAt);
		}
		// truncateToWidth can return "" when the next visible glyph is wider than
		// `available` (e.g. wide CJK char at width=1, or an ANSI escape boundary).
		// Force-consume one code unit so the loop always makes progress instead of
		// breaking and leaving an oversized `remaining` for enforceWidth to ellipsize.
		if (head.length === 0) head = remaining.slice(0, 1);
		out.push(prefix + (out.length === 0 ? formatStructuredLine(head, shape.kind) : head));
		const rest = remaining.slice(head.length);
		// Code-like lines keep their internal indentation across wrap chunks so
		// hand-aligned ASCII (stack frames, indented logs) does not collapse.
		remaining = shape.kind === "code" ? rest : rest.trimStart();
		prefix = visibleWidth(shape.continuation) < width ? shape.continuation : "";
		guard += 1;
	}
	if (remaining.length > 0) out.push(prefix + remaining);
	return out;
}

function wrapLines(text: string, width: number): string[] {
	if (width <= 0) return [];
	return sanitizeText(text).split("\n").flatMap((raw) => wrapTextLine(raw, width));
}

function enforceWidth(lines: string[], width: number): string[] {
	return lines.map((line) => {
		const safe = sanitizeText(line);
		return visibleWidth(safe) > width ? truncateToWidth(safe, width, "…") : safe;
	});
}

function padToWidth(line: string, width: number): string {
	const safe = sanitizeText(line);
	const truncated = visibleWidth(safe) > width ? truncateToWidth(safe, width, "…") : safe;
	const padding = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(padding);
}

class LabeledInput implements Component, Focusable {
	input: Input;
	label: string;
	focused = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;

	constructor(label: string) {
		this.label = label;
		this.input = new Input();
		this.input.onSubmit = (value) => this.onSubmit?.(value);
		this.input.onEscape = () => this.onEscape?.();
	}

	getValue(): string {
		return this.input.getValue();
	}

	setValue(value: string): void {
		this.input.setValue(value);
	}

	handleInput(data: string): void {
		if (data === "\r" || data === "\n") {
			this.onSubmit?.(this.input.getValue());
			return;
		}
		if (data.includes("\n") || data.includes("\r")) {
			this.input.handleInput(data.replace(/\r\n|\r|\n/g, " "));
			return;
		}
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		this.input.focused = this.focused;
		const labelWidth = visibleWidth(this.label);
		if (width <= labelWidth) {
			return [truncateToWidth(this.label, width, "…")];
		}
		const inputWidth = width - labelWidth + 2;
		const lines = this.input.render(Math.max(3, inputWidth));
		return lines.map((line) => {
			if (line.startsWith("> ")) {
				return this.label + line.slice(2);
			}
			return truncateToWidth(this.label + line, width, "…");
		});
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

interface WorkerRosterLayout {
	header: string[];
	lines: string[];
	selectedTop: number;
	selectedBottom: number;
	workerStarts: number[];
}

function buildWorkerRoster(snapshot: PersistedTeamState, width: number, selectedId: string | undefined): WorkerRosterLayout {
	const workers = Object.values(snapshot.activeWorkers);
	const wide = width >= 76;
	const identityWidth = Math.min(26, Math.max(12, ...workers.map((worker) => visibleWidth(workerIdentity(worker)))));
	const statusWidth = 18;
	const timeWidth = 6;
	const taskWidth = Math.max(1, width - identityWidth - statusWidth - timeWidth - 8);
	const widths = [identityWidth, statusWidth, taskWidth, timeWidth];
	const header = wide ? [muted("  " + alignedRow(["Worker", "Status", "Task", "Time"], widths, [3]))] : [];
	const lines: string[] = [];
	const workerStarts: number[] = [];
	let selectedTop = 0;
	let selectedBottom = 0;
	for (const section of buildRosterSections(snapshot)) {
		if (section.workers.length === 0) continue;
		if (lines.length > 0) lines.push("");
		lines.push(colorForGroupBold(section.key)(`${section.label} (${section.workers.length})`));
		for (const worker of section.workers) {
			const selected = worker.workerId === selectedId;
			const start = lines.length;
			workerStarts.push(start);
			let statusLabel = formatWorkerStatusLabel(worker);
			if (REUSABLE_STATUSES.has(worker.status)) statusLabel = `${worker.finalAnswer ? "Done" : "Idle"} [reuse]`;
			if (worker.status === "waiting_followup") statusLabel = "Waiting [reuse]";
			if (worker.pendingRelayQuestions.length > 0) statusLabel = "Needs reply";
			const status = colorForWorker(worker)(statusLabel);
			const task = sanitizeTerminalText(worker.currentTask?.title ?? worker.lastSummary?.headline ?? "No assigned task");
			const active = worker.status === "running" || worker.status === "starting" || worker.status === "waiting_followup";
			const end = active ? Date.now() : worker.lastEventAt;
			const seconds = Math.max(0, Math.floor((end - (worker.currentTask?.createdAt ?? worker.startedAt)) / 1000));
			const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
			let identity = workerIdentity(worker);
			if (hasClampedThinking(worker)) identity += warning(wide ? " (clamped)" : "!");
			if (wide) {
				// Keep the clamp marker visible even when a role name is long.
				if (hasClampedThinking(worker)) identity = truncateToWidth(workerIdentity(worker), identityWidth - 10, "…") + warning(" (clamped)");
				lines.push(selectedRow(alignedRow([identity, status, task, muted(elapsed)], widths, [3]), width, selected));
			} else {
				const statusAndTime = `${status} ${muted(elapsed)}`;
				const nameWidth = Math.max(1, width - visibleWidth(statusAndTime) - 4);
				if (hasClampedThinking(worker)) identity = truncateToWidth(workerIdentity(worker), Math.max(1, nameWidth - 1), "…") + warning("!");
				const main = padToWidth(truncateToWidth(identity, nameWidth, "…"), nameWidth) + "  " + statusAndTime;
				lines.push(selectedRow(main, width, selected));
				lines.push(...previewRows(task, width));
			}
			if (selected) {
				const detail = worker.pendingRelayQuestions[0]?.question ?? worker.error ?? worker.lastSummary?.headline;
				if (detail && detail !== task) {
					const style = section.key === "needs_reply" || section.key === "needs_recovery" ? colorForWorker(worker) : muted;
					lines.push(...previewRows(style(sanitizeTerminalText(detail)), width));
				}
				if (REUSABLE_STATUSES.has(worker.status)) lines.push(`    ${success("[reuse]")} ${muted("Session available for another task")}`);
				selectedTop = start;
				selectedBottom = lines.length;
			}
		}
	}
	if (workers.length === 0) lines.push(muted("No tracked workers. Press [n] to delegate one."));
	return { header, lines, selectedTop, selectedBottom, workerStarts };
}

function computeOverlayRows(termRows: number): number {
	// Match the overlay's maxHeight so the returned line count fits the panel
	// rectangle exactly. Without this, pi-tui truncates our output and the
	// bottom frame + footer disappear.
	return Math.max(1, Math.floor(termRows * OVERLAY_HEIGHT_PCT));
}

function frameRow(content: string, totalWidth: number): string {
	if (totalWidth <= 2) return muted(FRAME.vertical).repeat(totalWidth);
	if (totalWidth <= 4) {
		const innerWidth = Math.max(0, totalWidth - 2);
		const truncated = innerWidth === 0 ? "" : truncateToWidth(content, innerWidth, "");
		return `${muted(FRAME.vertical)}${truncated}${muted(FRAME.vertical)}`;
	}
	const innerWidth = totalWidth - 4;
	const padded = padToWidth(content, innerWidth);
	const sides = muted(FRAME.vertical);
	return `${sides} ${padded} ${sides}`;
}

function frameTopWithTitle(titleStyled: string, totalWidth: number): string {
	if (totalWidth <= 2) {
		return muted(FRAME.topLeft) + muted(FRAME.horizontal.repeat(Math.max(0, totalWidth - 1)));
	}
	const titleVisible = visibleWidth(titleStyled);
	const inner = totalWidth - 2;
	const titleFragment = ` ${titleStyled} `;
	const titleVisibleWithPad = titleVisible + 2;
	if (titleVisibleWithPad >= inner) {
		return muted(FRAME.topLeft) + truncateToWidth(titleFragment, inner, "…") + muted(FRAME.topRight);
	}
	const remaining = inner - titleVisibleWithPad;
	const leftPad = Math.min(2, remaining);
	const rightFill = remaining - leftPad;
	const top = `${muted(FRAME.topLeft)}${muted(FRAME.horizontal.repeat(leftPad))}${titleFragment}${muted(FRAME.horizontal.repeat(rightFill))}${muted(FRAME.topRight)}`;
	return top;
}

function frameBottom(totalWidth: number): string {
	if (totalWidth <= 0) return "";
	if (totalWidth === 1) return muted(FRAME.bottomLeft);
	const inner = totalWidth - 2;
	const bottom = `${muted(FRAME.bottomLeft)}${muted(FRAME.horizontal.repeat(inner))}${muted(FRAME.bottomRight)}`;
	return bottom;
}

// When `rows` doesn't fit `maxRows`, keep the top/bottom borders and drop
// middle content. If a `hint` row is provided, surface it as the last visible
// middle row so operators see why the panel looks empty instead of just blank chrome.
function clampFramedRows(rows: string[], maxRows: number, hint?: string): string[] {
	if (rows.length <= maxRows) return rows;
	if (maxRows <= 0) return [];
	if (maxRows === 1) return [rows[0] ?? ""];
	const top = rows[0] ?? "";
	const bottom = rows[rows.length - 1] ?? "";
	if (maxRows === 2) return [top, bottom];
	const middle = rows.slice(1, maxRows - 1);
	if (hint !== undefined && middle.length > 0) middle[middle.length - 1] = hint;
	return [top, ...middle, bottom];
}

export function buildTabBar(active: OverlayTab, routingMode: "team" | "solo", displayCost = true): string {
	const visibleTabs = displayCost ? TAB_ORDER : TAB_ORDER.filter((tab) => tab !== "cost");
	const cells = visibleTabs.map((tab) => {
		const num = TAB_ORDER.indexOf(tab) + 1;
		const label = `${num} ${TAB_LABELS[tab]}`;
		return tab === active ? accentBold(`[${label}]`) : dim(label);
	});
	const badge = routingMode === "solo" ? `  · ${warningBold("solo")}` : "";
	return cells.join(" ") + badge;
}

const ACTION_BAR_KEYS: Array<{ key: string; label: string }> = [
	{ key: "s", label: "teer" },
	{ key: "m", label: "sg" },
	{ key: "n", label: "ew" },
	{ key: "c", label: "lose" },
	{ key: "x", label: "cancel" },
	{ key: "p", label: "rune" },
	{ key: "r", label: "efresh" },
	{ key: "y", label: "copy" },
	{ key: "q", label: "uit" },
];

function buildActionBar(overrides: Partial<Record<string, string>> = {}): string {
	return ACTION_BAR_KEYS.map(({ key, label }) => `[${accentBold(key)}]${dim(overrides[key] ?? label)}`).join(" ");
}

function firstFitting(width: number, candidates: string[]): string {
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? candidates[candidates.length - 1] ?? "";
}

function buildSelectedWorkerHeader(worker: WorkerRuntimeState | undefined, width: number): string {
	if (!worker) return firstFitting(width, ["No worker selected · [n]ew task", "No worker selected", "none"]);
	const attention = getWorkerAttentionPriority(worker);
	const status = formatWorkerStatusLabel(worker);
	const action = attention === "needs_reply" || attention === "needs_recovery" ? ` · ${getWorkerPrimaryAction(worker)}` : "";
	return firstFitting(width, [
		`${worker.workerId} · ${worker.profileName} · ${status}${action}`,
		`${worker.workerId} · ${status}${action}`,
		`${worker.workerId} · ${status}`,
		worker.workerId,
	]);
}

function formatFollowHeader(following: boolean, top: number, visible: number, total: number): string {
	return `${following ? "[follow]" : "[paused]"}  ${formatScrollRange(top, visible, total)}`;
}

function formatScrollRange(top: number, visible: number, total: number): string {
	const start = total === 0 ? 0 : top + 1;
	const end = Math.min(total, top + visible);
	return `scroll ${start}-${end} / ${total}`;
}

function colorForGroupBold(group: WorkerAttentionGroup): (text: string) => string {
	switch (group) {
		case "needs_reply":
			return warningBold;
		case "needs_recovery":
			return dangerBold;
		case "in_progress":
			return accentBold;
		case "completed_or_idle":
			return currentPalette.successBold;
	}
}

function colorForWorker(worker: WorkerRuntimeState): (text: string) => string {
	if (worker.pendingRelayQuestions.length > 0) return warning;
	switch (worker.status) {
		case "running":
		case "starting":
			return accent;
		case "waiting_followup":
			return warning;
		case "idle":
		case "completed":
			return success;
		case "aborted":
		case "error":
		case "exited":
			return danger;
		default:
			return muted;
	}
}

interface OverlayTeamManager {
	snapshot(): PersistedTeamState;
	pingWorkers(options?: { mode?: "passive" | "active" }): Promise<unknown>;
	getWorkerTranscript(workerId: string): string | undefined;
	getWorkerConsole(workerId: string): WorkerConsoleEvent[] | undefined;
	getWorkerActivity?(workerId: string): WorkerActivityEvent[] | undefined;
	getAssistantTail(workerId: string, fromIndex?: number): AssistantChunk[];
	onAssistantChunk?(listener: (workerId: string, chunk: AssistantChunk) => void): () => void;
	onActivityEvent?(listener: (workerId: string, event: WorkerActivityEvent) => void): () => void;
	messageWorker?(workerId: string, message: string, delivery?: "auto" | "steer" | "follow_up"): Promise<AgentMessageResult>;
	closeWorker?(workerId: string, reason?: string): Promise<unknown>;
	cancelWorker?(workerId: string): Promise<unknown>;
	pruneTerminalWorkers?(): Promise<unknown[]>;
	delegateTask?(request: {
		title: string;
		goal: string;
		profileName: string;
		cwd: string;
		reuseWorkerId?: string;
	}): Promise<unknown>;
	routingMode?: "team" | "solo";
	config?: { profiles: Array<{ name: string }> };
	displayCost?: boolean;
}

export const TEAM_DASHBOARD_INITIAL_REFRESH_TIMEOUT_MS = 5_000;

export interface OpenTeamDashboardOptions {
	initialWorkerId?: string;
	cwd?: string;
	displayCost?: boolean;
	theme?: Theme;
	initialRefreshTimeoutMs?: number;
}

export function createTeamDashboardOverlayComponent(
	tui: OverlayLikeTui,
	teamManager: OverlayTeamManager,
	initialSnapshot: PersistedTeamState,
	done: () => void,
	options: OpenTeamDashboardOptions = {},
): {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	dispose(): void;
} {
	const displayCost = (options.displayCost ?? teamManager.displayCost) !== false;
	const visibleTabOrder: OverlayTab[] = displayCost ? TAB_ORDER : TAB_ORDER.filter((tab) => tab !== "cost");

	setPalette(options.theme);

	let snapshot = initialSnapshot;
	const initialWorker = options.initialWorkerId && initialSnapshot.activeWorkers[options.initialWorkerId]
		? options.initialWorkerId
		: undefined;
	const state: DashboardState = {
		tab: initialWorker ? "inspect" : "workers",
		selectedWorkerId: initialWorker,
		inspectScroll: 0,
		inspectFollow: false,
		inspectDetailsExpanded: false,
		workersScroll: 0,
		consoleScroll: 0,
		consoleFollow: true,
		consoleMode: "activity",
		consoleDetailsExpanded: true,
		consoleRevealSelection: false,
		helpExpanded: false,
		costScroll: 0,
	};
	let statusMessage: string | undefined;
	let statusExpires = 0;
	let lastRenderMetrics: RenderMetrics = { listPageSize: 8, bodyPageSize: 10 };
	const spinnerFrames = ["|", "/", "-", "\\"];
	let spinnerFrame = 0;
	let consoleAnimationTimer: ReturnType<typeof setInterval> | undefined;

	const requestRender = () => {
		tui.requestRender?.();
	};
	const updateConsoleAnimation = (animate: boolean) => {
		if (!animate) {
			if (consoleAnimationTimer) clearInterval(consoleAnimationTimer);
			consoleAnimationTimer = undefined;
		} else if (!consoleAnimationTimer) {
			consoleAnimationTimer = setInterval(() => {
				spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
				requestRender();
			}, 160);
			consoleAnimationTimer.unref();
		}
	};
	const setStatus = (message: string, durationMs = 2500) => {
		statusMessage = message;
		statusExpires = Date.now() + durationMs;
		requestRender();
	};
	const activeStatus = (): string | undefined => {
		if (!statusMessage) return undefined;
		if (Date.now() > statusExpires) {
			statusMessage = undefined;
			return undefined;
		}
		return statusMessage;
	};

	const offChunk = teamManager.onAssistantChunk?.((workerId) => {
		if (state.selectedWorkerId !== workerId) return;
		if (state.tab === "console" || state.tab === "inspect") {
			requestRender();
		}
	});
	const offActivity = teamManager.onActivityEvent?.((workerId) => {
		if (state.tab === "workers" || state.tab === "cost") {
			requestRender();
			return;
		}
		if (state.selectedWorkerId !== workerId) return;
		if (state.tab === "console" || state.tab === "inspect") {
			requestRender();
		}
	});
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		updateConsoleAnimation(false);
		offChunk?.();
		offActivity?.();
	};
	const finish = () => {
		dispose();
		done();
	};

	const ensureSelectedWorker = () => {
		const ids = getAttentionOrderedWorkerIds(snapshot);
		if (ids.length === 0) {
			state.selectedWorkerId = undefined;
			return;
		}
		if (state.selectedWorkerId && snapshot.activeWorkers[state.selectedWorkerId]) return;
		state.selectedWorkerId = ids[0];
		state.inspectScroll = 0;
		state.inspectFollow = false;
		state.inspectDetailsExpanded = false;
		state.consoleScroll = 0;
		state.consoleFollow = true;
		state.consoleSelectedActivityId = undefined;
		state.consoleDetailsExpanded = true;
		state.consoleRevealSelection = false;
		state.consoleMode = "activity";
	};
	const refreshSnapshot = () => {
		snapshot = teamManager.snapshot();
		ensureSelectedWorker();
	};
	const currentWorker = (): WorkerRuntimeState | undefined => {
		if (!state.selectedWorkerId) return undefined;
		return snapshot.activeWorkers[state.selectedWorkerId];
	};
	const moveSelection = (delta: number) => {
		const ids = getAttentionOrderedWorkerIds(snapshot);
		if (ids.length === 0) return;
		const current = state.selectedWorkerId ? ids.indexOf(state.selectedWorkerId) : 0;
		const safe = current >= 0 ? current : 0;
		const next = clamp(safe + delta, 0, ids.length - 1);
		state.selectedWorkerId = ids[next];
		state.inspectScroll = 0;
		state.inspectFollow = false;
		state.inspectDetailsExpanded = false;
		state.consoleScroll = 0;
		state.consoleFollow = true;
		state.consoleSelectedActivityId = undefined;
		state.consoleDetailsExpanded = true;
		state.consoleRevealSelection = false;
	};

	const refreshActive = () => {
		teamManager.pingWorkers({ mode: "active" })
			.then(() => {
				refreshSnapshot();
				setStatus(`Refreshed ${Object.keys(snapshot.activeWorkers).length} workers`);
			})
			.catch((error) => setStatus(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`, 4000));
	};

	const copyCurrent = () => {
		const worker = currentWorker();
		if (!worker) return setStatus("No worker selected — nothing to copy");
		const payload = buildCopyPayload(
			worker,
			teamManager.getWorkerTranscript(worker.workerId),
			teamManager.getWorkerConsole(worker.workerId),
			teamManager.getWorkerActivity?.(worker.workerId),
		);
		copyToClipboard(payload)
			.then(() => setStatus(`Copy complete — ${worker.workerId} (${payload.length.toLocaleString()} chars)`))
			.catch((error) => setStatus(`Warning — copy failed: ${error instanceof Error ? error.message : String(error)}`, 4000));
	};

	const openModal = (kind: ModalKind, workerId?: string) => {
		if (kind === "steer" || kind === "message") {
			if (!workerId) {
				setStatus("Select a worker first");
				return;
			}
			const worker = snapshot.activeWorkers[workerId];
			if (!worker) return;
			// Block only truly unreachable workers. `messageWorker` resolver
			// auto-upgrades steer/follow_up to a fresh prompt for idle and
			// waiting_followup, matching /team-steer.
			const unreachable = new Set<WorkerStatus>(["completed", "aborted", "error", "exited"]);
			if (unreachable.has(worker.status)) {
				setStatus(`Worker ${workerId} is ${worker.status} — RPC disposed; delegate fresh`);
				return;
			}
			const steerLabel = kind === "steer" ? `Steer ${workerId}: ` : `Message ${workerId}: `;
			const input = new LabeledInput(steerLabel);
			input.focused = true;
			input.onSubmit = () => { void submitModal(); };
			input.onEscape = () => { state.modal = undefined; setStatus("(cancelled)"); };
			state.modal = { kind, label: steerLabel, workerId, input };
			return;
		}
		// new_task
		if (!teamManager.delegateTask) {
			setStatus("delegate_task not wired in this context");
			return;
		}
		if (teamManager.routingMode === "solo") {
			setStatus("Team routing off. Run /team-enable on to delegate.");
			return;
		}
		const profile = currentWorker()?.profileName ?? teamManager.config?.profiles[0]?.name;
		if (!profile) {
			setStatus("No profile available for new task");
			return;
		}
		const newTaskLabel = `New task (${profile}): `;
		const newTaskInput = new LabeledInput(newTaskLabel);
		newTaskInput.focused = true;
		newTaskInput.onSubmit = () => { void submitModal(); };
		newTaskInput.onEscape = () => { state.modal = undefined; setStatus("(cancelled)"); };
		state.modal = { kind: "new_task", label: newTaskLabel, workerId: currentWorker()?.workerId, input: newTaskInput };
	};

	const submitModal = async () => {
		const modal = state.modal;
		if (!modal) return;
		const trimmed = modal.input.getValue().trim();
		state.modal = undefined;
		if (!trimmed) {
			setStatus("(empty input — cancelled)");
			return;
		}
		try {
			if (modal.kind === "steer" && modal.workerId) {
				const result = await teamManager.messageWorker?.(modal.workerId, trimmed, "steer");
				setStatus(result ? formatAgentMessageResult(result) : `Steering running agent ${modal.workerId}.`);
			} else if (modal.kind === "message" && modal.workerId) {
				const result = await teamManager.messageWorker?.(modal.workerId, trimmed, "auto");
				setStatus(result ? formatAgentMessageResult(result) : `Messaged agent ${modal.workerId}.`);
			} else if (modal.kind === "new_task") {
				if (teamManager.routingMode === "solo") {
					setStatus("Team routing off. Run /team-enable on to delegate.");
					return;
				}
				const profile = currentWorker()?.profileName ?? teamManager.config?.profiles[0]?.name;
				if (!profile) {
					setStatus("No profile available");
					return;
				}
				// Always delegate fresh: forwarding reuseWorkerId silently from the
				// selected worker would reset its <final_answer>/summary on submit,
				// which is surprising when the operator just had it open to read.
				await teamManager.delegateTask?.({
					title: trimmed.slice(0, 60),
					goal: trimmed,
					profileName: profile,
					cwd: options.cwd ?? process.cwd(),
				});
				setStatus(`Created ${profile} agent.`);
				refreshSnapshot();
			}
		} catch (error) {
			setStatus(`Action failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
		}
	};

	const closeSelected = async () => {
		const worker = currentWorker();
		if (!worker) return setStatus("No worker selected");
		if (!REUSABLE_STATUSES.has(worker.status)) {
			return setStatus(`Worker ${worker.workerId} is ${worker.status} — only idle/waiting can be closed; use [x]cancel for running`);
		}
		try {
			await teamManager.closeWorker?.(worker.workerId);
			setStatus(`Closed ${formatWorkerLabel(worker)}`);
		} catch (error) {
			setStatus(`Close failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
		}
	};
	const cancelSelected = async () => {
		const worker = currentWorker();
		if (!worker) return setStatus("No worker selected");
		try {
			await teamManager.cancelWorker?.(worker.workerId);
			setStatus(`Cancelled ${formatWorkerLabel(worker)}`);
		} catch (error) {
			setStatus(`Cancel failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
		}
	};
	const pruneTerminal = async () => {
		try {
			const removed = await teamManager.pruneTerminalWorkers?.() ?? [];
			setStatus(`Pruned ${removed.length} terminal worker${removed.length === 1 ? "" : "s"}`);
		} catch (error) {
			setStatus(`Prune failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
		}
	};

	const renderInspectBody = (width: number, rows: number): string[] => {
		const worker = currentWorker();
		if (!worker) {
			return enforceWidth(["No worker selected. Switch to Workers (1) to pick one."], width).slice(0, rows);
		}
		const body = wrapLines(buildInspectText(
			worker,
			state.inspectDetailsExpanded ? teamManager.getWorkerTranscript(worker.workerId) : undefined,
			teamManager.getWorkerConsole(worker.workerId),
			teamManager.getWorkerActivity?.(worker.workerId),
			currentPalette,
			displayCost,
			state.inspectDetailsExpanded,
		), width);
		// Reserve 1 row for the [follow]/scroll header; the rest is the visible window.
		const visible = Math.max(1, rows - 1);
		const maxTop = Math.max(0, body.length - visible);
		if (state.inspectFollow) state.inspectScroll = maxTop;
		const top = clamp(state.inspectScroll, 0, maxTop);
		state.inspectScroll = top;
		lastRenderMetrics.bodyPageSize = visible;
		const header = formatFollowHeader(state.inspectFollow, top, visible, body.length);
		return enforceWidth([header, ...body.slice(top, top + visible)], width);
	};

	const currentActivity = (): WorkerActivityEvent[] => {
		const worker = currentWorker();
		if (!worker) return [];
		return getConsoleActivity(teamManager.getAssistantTail(worker.workerId), teamManager.getWorkerConsole(worker.workerId) ?? [], teamManager.getWorkerActivity?.(worker.workerId));
	};

	const moveActivitySelection = (delta: number): void => {
		const activity = currentActivity();
		if (activity.length === 0) return;
		const index = activity.findIndex((event) => event.id === state.consoleSelectedActivityId);
		const next = clamp((index >= 0 ? index : activity.length - 1) + delta, 0, activity.length - 1);
		state.consoleSelectedActivityId = activity[next]!.id;
		state.consoleDetailsExpanded = true;
		state.consoleRevealSelection = true;
		state.consoleFollow = false;
	};

	const renderConsoleBody = (width: number, rows: number): string[] => {
		const worker = currentWorker();
		if (!worker) return enforceWidth(["No worker selected. Pick one in Workers."], width).slice(0, rows);
		const chunks = teamManager.getAssistantTail(worker.workerId);
		const events = teamManager.getWorkerConsole(worker.workerId) ?? [];
		const activity = getConsoleActivity(chunks, events, teamManager.getWorkerActivity?.(worker.workerId));
		updateConsoleAnimation(!disposed && state.consoleMode === "activity" && worker.status === "running" && activity.some((event) => event.status === "started"));
		if (state.consoleFollow || !activity.some((event) => event.id === state.consoleSelectedActivityId)) {
			state.consoleSelectedActivityId = activity[activity.length - 1]?.id;
		}
		const rendered = state.consoleMode === "raw"
			? { lines: wrapLines(buildRawConsoleLines(worker, chunks, events).join("\n"), width), selectedTop: undefined, selectedBottom: undefined }
			: buildActivityConsoleLines(activity, width, state.consoleSelectedActivityId, state.consoleDetailsExpanded, spinnerFrames[spinnerFrame]!);
		const all = rendered.lines;
		const visible = Math.max(1, rows - 1);
		const maxTop = Math.max(0, all.length - visible);
		if (state.consoleFollow) state.consoleScroll = maxTop;
		if (state.consoleRevealSelection && rendered.selectedTop !== undefined) {
			if (rendered.selectedTop < state.consoleScroll || (rendered.selectedBottom ?? 0) > state.consoleScroll + visible) state.consoleScroll = rendered.selectedTop;
			state.consoleRevealSelection = false;
		}
		const top = clamp(state.consoleScroll, 0, maxTop);
		state.consoleScroll = top;
		lastRenderMetrics.bodyPageSize = visible;
		const header = `${state.consoleMode === "activity" ? "Activity" : "Raw"} · ${formatFollowHeader(state.consoleFollow, top, visible, all.length)}`;
		return enforceWidth([dim(header), ...all.slice(top, top + visible)], width);
	};

	const renderCostBody = (width: number, rows: number): string[] => {
		const layout = buildCostLayout(snapshot, width, state.selectedWorkerId);
		let summary = wrapLines(layout.summary.join("\n"), width);
		if (summary.length + layout.header.length + 3 > rows) summary = summary.slice(0, 1);
		const header = rows > summary.length + 3 ? layout.header : [];
		const visible = Math.max(1, rows - summary.length - header.length - 2);
		const maxTop = Math.max(0, layout.rows.length - visible);
		const top = clamp(state.costScroll, 0, maxTop);
		state.costScroll = top;
		lastRenderMetrics.bodyPageSize = visible;
		const range = dim(`Cost · ${formatScrollRange(top, visible, layout.rows.length)}`);
		return enforceWidth([...summary, "", range, ...header, ...layout.rows.slice(top, top + visible)], width).slice(0, rows);
	};

	const renderBody = (width: number, rows: number): string[] => {
		if (rows <= 0) return [];
		switch (state.tab) {
			case "workers":
				return renderWorkersBody(width, rows);
			case "inspect":
				return renderInspectBody(width, rows);
			case "console":
				return renderConsoleBody(width, rows);
			case "cost":
				return renderCostBody(width, rows);
		}
	};

	function renderWorkersBody(width: number, rows: number): string[] {
		const roster = buildWorkerRoster(snapshot, width, state.selectedWorkerId);
		const header = rows >= 4 ? roster.header : [];
		const visible = Math.max(1, rows - header.length - 1);
		let top = clamp(state.workersScroll, 0, Math.max(0, roster.lines.length - visible));
		if (roster.selectedTop < top || roster.selectedBottom - roster.selectedTop > visible) top = roster.selectedTop;
		else if (roster.selectedBottom > top + visible) top = roster.selectedBottom - visible;
		state.workersScroll = top;
		lastRenderMetrics.listPageSize = Math.max(1, roster.workerStarts.filter((start) => start >= top && start < top + visible).length);
		const range = dim(`Workers · ${formatScrollRange(top, visible, roster.lines.length)}`);
		return enforceWidth([range, ...header, ...roster.lines.slice(top, top + visible)], width).slice(0, rows);
	}

	ensureSelectedWorker();

	const handleModalInput = (data: string): boolean => {
		if (!state.modal) return false;
		state.modal.input.handleInput(data);
		return true;
	};

	const handleNumberKey = (data: string): boolean => {
		const numIdx = ["1", "2", "3", "4"].indexOf(data);
		if (numIdx < 0) return false;
		const tab = TAB_ORDER[numIdx];
		if (!tab || !visibleTabOrder.includes(tab)) return false;
		state.tab = tab;
		return true;
	};

	const isPageUpKey = (data: string): boolean => data === "b" || matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u");
	const isPageDownKey = (data: string): boolean => data === " " || matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d");
	const isTopKey = (data: string): boolean => data === "g" || matchesKey(data, "home") || matchesKey(data, "alt+up");
	const isBottomKey = (data: string): boolean => data === "G" || matchesKey(data, "end") || matchesKey(data, "alt+down");
	const isFollowToggleKey = (data: string): boolean => data === "f" || matchesKey(data, "alt+f");

	return {
		render(width: number): string[] {
			refreshSnapshot();
			if (state.tab !== "console" || !currentWorker()) updateConsoleAnimation(false);
			const cap = Math.min(width, Math.max(1, tui.terminal.columns));
			const innerWidth = Math.max(1, cap - 4); // outer frame: │ + space + content + space + │
			const totalRows = computeOverlayRows(tui.terminal.rows);
			const routingMode = teamManager.routingMode ?? "team";
			const status = activeStatus();

			const titleRaw = "Pi Agents Team · /team";
			const titleStyled = accentBold(titleRaw);
			const tabBar = buildTabBar(state.tab, routingMode, displayCost);
			const fullTabHint = displayCost ? "1-4 tabs" : "1-3 tabs";
			const compactTabHint = displayCost ? "1-4" : "1-3";
			let helpRow: string;
			if (state.tab === "workers") helpRow = firstFitting(innerWidth, [
				`↑/↓ select · enter inspect · space/b page · g/G ends · ${fullTabHint}`,
				`↑↓ select · enter inspect · space/b · g/G · ${compactTabHint}`,
				`↑↓ · enter · space/b · g/G · ${compactTabHint}`,
			]);
			else if (state.tab === "console" && state.consoleMode === "activity") helpRow = firstFitting(innerWidth, [
				`↑/↓ select · enter details · f follow · space/b page · g/G ends · ${fullTabHint}`,
				`↑↓ select · enter details · f · space/b · g/G · ${compactTabHint}`,
				`↑↓ · enter · f · space/b · g/G`,
			]);
			else if (state.tab === "inspect") helpRow = firstFitting(innerWidth, [
				`↑/↓ scroll · enter details · f follow · space/b page · g/G ends · ${fullTabHint}`,
				`↑↓ scroll · enter details · f · space/b · g/G · ${compactTabHint}`,
				`↑↓ · enter · f · space/b · g/G`,
			]);
			else if (state.tab === "console") helpRow = firstFitting(innerWidth, [
				`↑/↓ scroll · f follow · space/b page · g/G top/bottom · ${fullTabHint}`,
				`↑↓ scroll · f follow · space/b · g/G · ${compactTabHint}`,
				`↑↓ · f · space/b · g/G · ${compactTabHint}`,
			]);
			else helpRow = firstFitting(innerWidth, [
				`↑/↓ scroll · space/b page · g/G top/bottom · ${fullTabHint}`,
				`↑↓ scroll · space/b · g/G · ${compactTabHint}`,
				`↑↓ · space/b · g/G · ${compactTabHint}`,
			]);
			const worker = currentWorker();
			const summaryRow = teamSummaryLine(snapshot, innerWidth);
			const selectedHeader = buildSelectedWorkerHeader(worker, innerWidth);
			const headerLines = [tabBar, summaryRow, bold(selectedHeader)];

			const footerLines: string[] = [];
			if (state.modal) {
				const inputLines = state.modal.input.render(innerWidth);
				const hint = dim("  (enter submit · esc cancel)");
				if (inputLines.length > 0) {
					const lastIndex = inputLines.length - 1;
					inputLines[lastIndex] = accent(inputLines[lastIndex]) + hint;
				}
				footerLines.push(...inputLines);
			}
			footerLines.push(dim(helpRow));
			let rLabel = "refresh";
			if (state.tab === "console") rLabel = state.consoleMode === "activity" ? "raw" : "activity";
			if (state.helpExpanded) footerLines.push(...wrapLines(buildActionBar({ r: rLabel }) + "  [?]less", innerWidth));
			else footerLines.push(firstFitting(innerWidth, [
				`[s]teer  [n]ew  [r]${rLabel}  [y]copy  [?]help  [q]uit`,
				`[s]teer  [r]${rLabel}  [?]help  [q]uit`,
				`[r]${rLabel}  [?]help  [q]uit`,
			]));
			if (status) footerLines.push(accent(`» ${status}`));

			// Reserve rows: top frame (1) + header lines + blank + body + blank + footer + bottom frame (1).
			const overhead = 1 + headerLines.length + 1 + 1 + footerLines.length + 1;
			const bodyRows = Math.max(0, totalRows - overhead);

			const body = renderBody(innerWidth, bodyRows);
			while (body.length < bodyRows) body.push("");

			const innerLines = enforceWidth([...headerLines, "", ...body, "", ...footerLines], innerWidth);
			const framedRows = innerLines.map((line) => frameRow(line, cap));
			const top = frameTopWithTitle(titleStyled, cap);
			const bottom = frameBottom(cap);
			const totalFrameRows = framedRows.length + 2;
			const tinyHint = totalFrameRows > totalRows ? frameRow(dim("(terminal too small)"), cap) : undefined;
			return clampFramedRows([top, ...framedRows, bottom], totalRows, tinyHint);
		},
		invalidate() {
			setPalette(options.theme);
			requestRender();
		},
		dispose() {
			dispose();
		},
		handleInput(data: string) {
			if (handleModalInput(data)) {
				requestRender();
				return;
			}

			if (data === "?") {
				state.helpExpanded = !state.helpExpanded;
				requestRender();
				return;
			}
			if (data === "q") return finish();
			if (matchesKey(data, "escape")) return finish();

			if (handleNumberKey(data)) {
				requestRender();
				return;
			}
			if (matchesKey(data, "tab")) {
				const idx = visibleTabOrder.indexOf(state.tab);
				state.tab = visibleTabOrder[(idx + 1) % visibleTabOrder.length]!;
				requestRender();
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				const idx = visibleTabOrder.indexOf(state.tab);
				state.tab = visibleTabOrder[(idx - 1 + visibleTabOrder.length) % visibleTabOrder.length]!;
				requestRender();
				return;
			}

			// Legacy `o` / `d` aliases land you on Inspect (the merged Overview/Deliverable view).
			// `c` is no longer the Console alias — it's the action-bar close hotkey.
			if (data === "o" || data === "d") {
				state.tab = "inspect";
				requestRender();
				return;
			}

			// Action bar hotkeys.
			if (data === "s") {
				openModal("steer", state.selectedWorkerId);
				requestRender();
				return;
			}
			if (data === "m") {
				openModal("message", state.selectedWorkerId);
				requestRender();
				return;
			}
			if (data === "n") {
				openModal("new_task");
				requestRender();
				return;
			}
			if (data === "c") {
				void closeSelected();
				requestRender();
				return;
			}
			if (data === "x") {
				void cancelSelected();
				requestRender();
				return;
			}
			if (data === "p") {
				void pruneTerminal();
				requestRender();
				return;
			}
			if (data === "r") {
				if (state.tab === "console") {
					state.consoleMode = state.consoleMode === "activity" ? "raw" : "activity";
					state.consoleRevealSelection = state.consoleMode === "activity";
					state.consoleScroll = 0;
					state.consoleFollow = false;
					setStatus(`Console ${state.consoleMode} view`);
				} else {
					refreshActive();
				}
				requestRender();
				return;
			}
			if (data === "y") {
				copyCurrent();
				requestRender();
				return;
			}

			// List/scroll navigation per tab.
			if (state.tab === "workers") {
				if (data === "j" || matchesKey(data, "down")) { moveSelection(1); requestRender(); return; }
				if (data === "k" || matchesKey(data, "up")) { moveSelection(-1); requestRender(); return; }
				if (isPageDownKey(data)) { moveSelection(lastRenderMetrics.listPageSize); requestRender(); return; }
				if (isPageUpKey(data)) { moveSelection(-lastRenderMetrics.listPageSize); requestRender(); return; }
				if (matchesKey(data, "enter")) {
					if (state.selectedWorkerId) state.tab = "inspect";
					requestRender();
					return;
				}
				if (isTopKey(data)) {
					const ids = getAttentionOrderedWorkerIds(snapshot);
					if (ids.length > 0) state.selectedWorkerId = ids[0];
					requestRender();
					return;
				}
				if (isBottomKey(data)) {
					const ids = getAttentionOrderedWorkerIds(snapshot);
					if (ids.length > 0) state.selectedWorkerId = ids[ids.length - 1];
					requestRender();
					return;
				}
				return;
			}

			if (state.tab === "inspect") {
				if (matchesKey(data, "enter")) {
					state.inspectDetailsExpanded = !state.inspectDetailsExpanded;
					state.inspectScroll = 0;
					state.inspectFollow = false;
					requestRender();
					return;
				}
				if (isFollowToggleKey(data)) { state.inspectFollow = !state.inspectFollow; requestRender(); return; }
				if (data === "j" || matchesKey(data, "down")) { state.inspectScroll += 1; state.inspectFollow = false; requestRender(); return; }
				if (data === "k" || matchesKey(data, "up")) { state.inspectScroll = Math.max(0, state.inspectScroll - 1); state.inspectFollow = false; requestRender(); return; }
				if (isPageDownKey(data)) { state.inspectScroll += lastRenderMetrics.bodyPageSize; state.inspectFollow = false; requestRender(); return; }
				if (isPageUpKey(data)) { state.inspectScroll = Math.max(0, state.inspectScroll - lastRenderMetrics.bodyPageSize); state.inspectFollow = false; requestRender(); return; }
				if (isTopKey(data)) { state.inspectScroll = 0; state.inspectFollow = false; requestRender(); return; }
				if (isBottomKey(data)) { state.inspectFollow = true; requestRender(); return; }
				return;
			}

			if (state.tab === "console") {
				if (matchesKey(data, "enter") && state.consoleMode === "activity") {
					state.consoleDetailsExpanded = !state.consoleDetailsExpanded;
					state.consoleRevealSelection = true;
					requestRender();
					return;
				}
				if (isFollowToggleKey(data)) {
					state.consoleFollow = !state.consoleFollow;
					requestRender();
					return;
				}
				if (data === "j" || matchesKey(data, "down")) {
					if (state.consoleMode === "activity") moveActivitySelection(1);
					else state.consoleScroll += 1;
					state.consoleFollow = false;
					requestRender();
					return;
				}
				if (data === "k" || matchesKey(data, "up")) {
					if (state.consoleMode === "activity") moveActivitySelection(-1);
					else state.consoleScroll = Math.max(0, state.consoleScroll - 1);
					state.consoleFollow = false;
					requestRender();
					return;
				}
				if (isPageUpKey(data)) {
					state.consoleScroll = Math.max(0, state.consoleScroll - lastRenderMetrics.bodyPageSize);
					state.consoleFollow = false;
					requestRender();
					return;
				}
				if (isPageDownKey(data)) {
					state.consoleScroll += lastRenderMetrics.bodyPageSize;
					state.consoleFollow = false;
					requestRender();
					return;
				}
				if (isBottomKey(data)) {
					state.consoleFollow = true;
					requestRender();
					return;
				}
				if (isTopKey(data)) {
					if (state.consoleMode === "activity") moveActivitySelection(-Number.MAX_SAFE_INTEGER);
					state.consoleScroll = 0;
					state.consoleFollow = false;
					requestRender();
					return;
				}
				return;
			}

			if (state.tab === "cost") {
				if (data === "j" || matchesKey(data, "down")) { state.costScroll += 1; requestRender(); return; }
				if (data === "k" || matchesKey(data, "up")) { state.costScroll = Math.max(0, state.costScroll - 1); requestRender(); return; }
				if (isPageDownKey(data)) { state.costScroll += lastRenderMetrics.bodyPageSize; requestRender(); return; }
				if (isPageUpKey(data)) { state.costScroll = Math.max(0, state.costScroll - lastRenderMetrics.bodyPageSize); requestRender(); return; }
				if (isTopKey(data)) { state.costScroll = 0; requestRender(); return; }
				if (isBottomKey(data)) { state.costScroll = Number.MAX_SAFE_INTEGER; requestRender(); return; }
			}
		},
	};
}

export async function openTeamDashboardOverlay(
	ctx: ExtensionContext,
	teamManager: TeamManager,
	options: OpenTeamDashboardOptions = {},
): Promise<void> {
	const initialState = teamManager.snapshot();
	const focusWorkerId = options.initialWorkerId && initialState.activeWorkers[options.initialWorkerId]
		? options.initialWorkerId
		: undefined;

	if (ctx.mode !== "tui") {
		await teamManager.pingWorkers({ mode: "active" }).catch(() => {});
		console.log(buildTeamDashboardText(teamManager.snapshot()));
		return;
	}

	class DashboardLoader implements Component {
		private child: Component & { dispose?(): void; handleInput?(data: string): void };
		private disposed = false;
		private disposeHandlers: Array<() => void> = [];
		constructor(child: Component & { dispose?(): void; handleInput?(data: string): void }) {
			this.child = child;
		}
		onDispose(handler: () => void): void {
			if (this.disposed) {
				handler();
				return;
			}
			this.disposeHandlers.push(handler);
		}
		isDisposed(): boolean {
			return this.disposed;
		}
		replace(child: Component & { dispose?(): void; handleInput?(data: string): void }): void {
			if (this.disposed) {
				child.dispose?.();
				return;
			}
			this.child.dispose?.();
			this.child = child;
		}
		render(width: number): string[] {
			return this.child.render(width);
		}
		invalidate(): void {
			this.child.invalidate?.();
		}
		handleInput(data: string): void {
			this.child.handleInput?.(data);
		}
		dispose(): void {
			if (this.disposed) return;
			this.disposed = true;
			for (const handler of this.disposeHandlers.splice(0)) handler();
			this.child.dispose?.();
		}
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const resolvedTheme = resolveTheme(theme as Theme | undefined);
			const loader = new BorderedLoader(tui, resolvedTheme, "Loading team dashboard…", { cancellable: false });
			const wrapper = new DashboardLoader(loader);
			const timeoutMs = Math.max(0, options.initialRefreshTimeoutMs ?? TEAM_DASHBOARD_INITIAL_REFRESH_TIMEOUT_MS);
			let dashboardShown = false;
			const showDashboard = () => {
				if (dashboardShown || wrapper.isDisposed()) return;
				dashboardShown = true;
				const state = teamManager.snapshot();
				const resolvedFocusWorkerId = options.initialWorkerId && state.activeWorkers[options.initialWorkerId]
					? options.initialWorkerId
					: focusWorkerId;
				wrapper.replace(createTeamDashboardOverlayComponent(
					tui as TUI,
					teamManager as unknown as OverlayTeamManager,
					state,
					done,
					{ initialWorkerId: resolvedFocusWorkerId, cwd: options.cwd ?? ctx.cwd, displayCost: options.displayCost, theme: resolvedTheme },
				));
				tui.requestRender();
			};
			const timer = setTimeout(showDashboard, timeoutMs);
			wrapper.onDispose(() => clearTimeout(timer));
			teamManager.pingWorkers({ mode: "active" })
				.catch(() => {})
				.then(() => {
					clearTimeout(timer);
					showDashboard();
				});
			return wrapper;
		},
		{
			overlay: true,
			overlayOptions: TEAM_DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}

export { buildTeamDashboardText, sanitizeText };
