import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	CURSOR_MARKER,
	Input,
	matchesKey,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, OverlayOptions, SelectItem, SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { AgentMessageResult, TeamManager } from "../control-plane/team-manager";
import type { AssistantChunk, WorkerConsoleEvent } from "../runtime/worker-manager";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage";
import { copyToClipboard } from "../util/clipboard";
import { buildCopyPayload } from "./copy-payload";
import { buildActionSummaryLine, buildCompactTeamSummaryLine, buildRosterSections, buildTeamDashboardText, buildWorkerPrioritySnippet, type WorkerAttentionGroup, getWorkerAttentionGroup } from "./dashboard";
import { formatCacheUsage, formatCompactTokenCount, formatContextBudget } from "./usage-format";
import { formatWorkerLabel, formatWorkerStatusLabel, getWorkerAttentionDisplay, getWorkerAttentionPriority, getWorkerPrimaryAction } from "./display-grammar";
import { formatAgentMessageResult } from "./tool-formatters";
import { FRAME, stripAnsi, fallbackPalette, themedPalette, type ThemedPalette } from "./theme";

// The overlay is a single-instance custom component. Styling helpers delegate
// to a mutable palette so the Pi Theme object supplied by ctx.ui.custom can be
// applied, invalidated, and rebuilt without threading a palette through every
// standalone helper signature.
let currentPalette: ThemedPalette = fallbackPalette;

const bold = (text: string): string => currentPalette.bold(text);
const dim = (text: string): string => currentPalette.dim(text);
const muted = (text: string): string => currentPalette.muted(text);
const accent = (text: string): string => currentPalette.accent(text);
const accentBold = (text: string): string => currentPalette.accentBold(text);
const success = (text: string): string => currentPalette.success(text);
const successBold = (text: string): string => currentPalette.successBold(text);
const warning = (text: string): string => currentPalette.warning(text);
const warningBold = (text: string): string => currentPalette.warningBold(text);
const danger = (text: string): string => currentPalette.danger(text);
const dangerBold = (text: string): string => currentPalette.dangerBold(text);
const inverse = (text: string): string => currentPalette.inverse(text);

function setPalette(theme?: Theme): void {
	// The factory may hand us an empty object in tests; only switch to a real
	// Pi Theme when the expected callbacks are present so styling never breaks.
	if (theme && typeof (theme as Theme).fg === "function" && typeof (theme as Theme).bold === "function") {
		currentPalette = themedPalette(theme);
	} else {
		currentPalette = fallbackPalette;
	}
}

type OverlayTab = "workers" | "inspect" | "console" | "cost";
type LayoutMode = "stack" | "split";
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
	consoleScroll: number;
	consoleFollow: boolean;
	costScroll: number;
	modal?: ModalState;
}

interface RenderMetrics {
	layout: LayoutMode;
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
const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
	"idle",
	"completed",
	"aborted",
	"error",
	"exited",
]);

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function appendList(lines: string[], label: string, values: string[]): void {
	if (values.length === 0) return;
	lines.push(dim(label));
	for (const value of values) lines.push(`  ${value}`);
}

function inspectSection(label: string, palette: ThemedPalette = currentPalette): string {
	return palette.accentBold(label);
}

function inspectDivider(label: string, palette: ThemedPalette = currentPalette): string {
	return palette.accent(FRAME.horizontal.repeat(2)) + " " + inspectSection(label, palette) + " " + palette.accent(FRAME.horizontal.repeat(2));
}

function inspectField(label: string, value: string, palette: ThemedPalette = currentPalette): string {
	return `  ${palette.dim(label)} ${value}`;
}

function formatUsage(worker: WorkerRuntimeState): string {
	const parts = [
		`turns=${worker.usage.turns}`,
		`in=${formatCompactTokenCount(worker.usage.inputTokens)}`,
		`out=${formatCompactTokenCount(worker.usage.outputTokens)}`,
		formatCacheUsage(worker.usage),
		`cost=$${worker.usage.costUsd.toFixed(4)}`,
		formatContextBudget(worker.usage),
	].filter((part): part is string => Boolean(part));
	return parts.join("  ");
}

function hasClampedThinking(worker: WorkerRuntimeState): boolean {
	return worker.requestedThinkingLevel !== worker.effectiveThinkingLevel;
}

function formatThinking(worker: WorkerRuntimeState, palette: ThemedPalette): string {
	if (!hasClampedThinking(worker)) return worker.effectiveThinkingLevel;
	return palette.warning(`${worker.requestedThinkingLevel} -> ${worker.effectiveThinkingLevel} (clamped)`);
}

function formatRosterProfileName(worker: WorkerRuntimeState): string {
	return `${worker.profileName}${hasClampedThinking(worker) ? " (clamped)" : ""}`;
}

function buildInspectText(worker: WorkerRuntimeState, transcript: string | undefined, palette: ThemedPalette): string {
	const lines = [
		`${worker.workerId} · ${worker.profileName} · ${worker.status}${REUSABLE_STATUSES.has(worker.status) ? "  [reusable]" : ""}`,
		"",
		inspectSection("Status", palette),
		inspectField("Usage:", formatUsage(worker), palette),
		inspectField("Thinking:", formatThinking(worker, palette), palette),
	];
	if (worker.lastToolName) lines.push(inspectField("Last tool:", worker.lastToolName, palette));
	if (worker.error) lines.push(inspectField("Error:", palette.danger(worker.error), palette));

	lines.push("", inspectSection("Task"));
	if (worker.currentTask) {
		lines.push(`  ${worker.currentTask.title}`);
		if (worker.currentTask.goal) lines.push(inspectField("Goal:", worker.currentTask.goal));
		if (worker.currentTask.expectedOutput) lines.push(inspectField("Expected:", worker.currentTask.expectedOutput));
		appendList(lines, "  Context:", worker.currentTask.contextHints);
		if (worker.currentTask.pathScope) appendList(lines, "  Path scope:", worker.currentTask.pathScope.roots);
	} else {
		lines.push("  (none)");
	}

	lines.push("", inspectSection("Needs operator"));
	if (worker.pendingRelayQuestions.length === 0) {
		lines.push("  (none)");
	} else {
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`  ${warningBold(`[${relay.urgency}]`)} ${relay.question}`);
			lines.push(inspectField("Assumption:", relay.assumption));
		}
	}

	lines.push("", inspectSection("Summary"));
	if (worker.lastSummary) {
		lines.push(inspectField("Headline:", worker.lastSummary.headline));
		appendList(lines, "  Read files:", worker.lastSummary.readFiles);
		appendList(lines, "  Changed files:", worker.lastSummary.changedFiles);
		appendList(lines, "  Risks:", worker.lastSummary.risks);
		if (worker.lastSummary.nextRecommendation) lines.push(inspectField("Next:", worker.lastSummary.nextRecommendation));
	} else {
		lines.push("  (no summary captured yet)");
	}

	lines.push("", inspectDivider("Final answer"));
	lines.push(worker.finalAnswer?.trim() || "  (no <final_answer> block produced)");

	lines.push("", inspectDivider("Latest assistant text"));
	lines.push(transcript?.trim() || "  (no assistant text captured)");
	return lines.join("\n");
}

function styleConsoleEventKind(event: WorkerConsoleEvent): string {
	const label = `[${event.kind}]`;
	if (event.kind === "error") return dangerBold(label);
	if (event.kind === "exit" || /\brecover(?:y|ed|ing)?\b/i.test(event.text)) return warningBold(label);
	return dim(label);
}

function styleConsoleEventText(event: WorkerConsoleEvent): string {
	if (event.kind === "error") return danger(event.text);
	if (event.kind === "exit" || /\brecover(?:y|ed|ing)?\b/i.test(event.text)) return warning(event.text);
	return event.text;
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `${dim(`[${formatTimestamp(event.ts)}]`)} ${styleConsoleEventKind(event)} ${styleConsoleEventText(event)}`;
}

function buildConsoleLines(
	worker: WorkerRuntimeState,
	chunks: AssistantChunk[],
	consoleEvents: WorkerConsoleEvent[],
): string[] {
	if (chunks.length === 0 && consoleEvents.length === 0) {
		return [`${worker.workerId} · ${worker.profileName} · ${worker.status}`, "", "(no console activity yet)"];
	}
	const lines = [`${worker.workerId} · ${worker.profileName} · ${worker.status}  ·  chunks=${chunks.length}  events=${consoleEvents.length}`, ""];
	lines.push(accentBold("— assistant —"));
	if (chunks.length === 0) {
		lines.push(dim("(no assistant text captured)"));
	} else {
		for (const chunk of chunks) {
			lines.push(dim(`[${formatTimestamp(chunk.ts)}]`));
			const text = chunk.text.replace(/\r/g, "");
			const parts = text.split("\n");
			for (const part of parts) lines.push(part);
		}
	}
	lines.push("", accentBold("— events —"));
	if (consoleEvents.length === 0) {
		lines.push(dim("(no events captured)"));
	} else {
		for (const event of consoleEvents) lines.push(formatConsoleEvent(event));
	}
	return lines;
}

function formatCachePart(usage: { cacheReadTokens: number; cacheWriteTokens: number }): string {
	const cache = formatCacheUsage(usage);
	return cache ? `  ${cache}` : "";
}

function buildCostLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers);
	const total = aggregateWorkerUsage(workers, state.prunedWorkerUsageTotals);
	const retained = state.prunedWorkerUsageTotals;
	if (workers.length === 0 && !hasWorkerUsage(retained)) return ["(no tracked workers)"];
	const rows: string[] = [];
	if (hasWorkerUsage(retained)) {
		rows.push(
			`retained/pruned: workers=${retained.workers}  turns=${retained.turns}  in=${formatCompactTokenCount(retained.inputTokens)}  out=${formatCompactTokenCount(retained.outputTokens)}${formatCachePart(retained)}  cost=$${retained.costUsd.toFixed(4)}`,
		);
	}
	for (const worker of workers) {
		rows.push(
			`  ${worker.workerId.padEnd(6)} ${worker.profileName.padEnd(12)} turns=${worker.usage.turns}  in=${formatCompactTokenCount(worker.usage.inputTokens)}  out=${formatCompactTokenCount(worker.usage.outputTokens)}${formatCachePart(worker.usage)}  cost=$${worker.usage.costUsd.toFixed(4)}`,
		);
	}
	return [
		`Σ workers=${total.workers}  turns=${total.turns}  in=${formatCompactTokenCount(total.inputTokens)}  out=${formatCompactTokenCount(total.outputTokens)}${formatCachePart(total)}  cost=$${total.costUsd.toFixed(4)}`,
		"",
		...(rows.length > 0 ? rows : ["(no tracked workers)"]),
	];
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

class RosterSelectList implements Component {
	constructor(
		private snapshot: PersistedTeamState,
		private selectedWorkerId?: string,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const items: SelectItem[] = [];
		for (const section of buildRosterSections(this.snapshot)) {
			if (section.workers.length === 0) continue;
			items.push({
				value: `__section__${section.key}`,
				label: colorForGroupBold(section.key)(`${section.label} (${section.workers.length})`),
			});
			for (const worker of section.workers) {
				const base = `${worker.workerId} · ${formatRosterProfileName(worker)} · ${worker.status}${REUSABLE_STATUSES.has(worker.status) ? " [reuse]" : ""} · ${buildWorkerPrioritySnippet(worker)}`;
				items.push({ value: worker.workerId, label: colorForWorker(worker)(base) });
			}
		}
		if (items.length === 0) {
			return [dim("No tracked workers. Press [n] to delegate one.")];
		}
		const workerIndices = items
			.map((item, index) => (item.value.startsWith("__section__") ? -1 : index))
			.filter((index) => index >= 0);
		const selectedIndex = this.selectedWorkerId
			? workerIndices.find((index) => items[index].value === this.selectedWorkerId)
			: undefined;
		const safeSelectedIndex = selectedIndex ?? workerIndices[0] ?? 0;
		const theme: SelectListTheme = {
			selectedText: (text) => bold(text),
			selectedPrefix: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		};
		const list = new SelectList(items, items.length, theme);
		list.setSelectedIndex(safeSelectedIndex);
		return list.render(width).map((line) => {
			const plain = stripAnsi(line);
			if (plain.startsWith("→ ")) {
				const arrowIndex = line.indexOf("→ ");
				return line.slice(0, arrowIndex) + "▶ " + line.slice(arrowIndex + 2);
			}
			return line;
		});
	}
}

function computeOverlayRows(termRows: number): number {
	// Match the overlay's maxHeight so the returned line count fits the panel
	// rectangle exactly. Without this, pi-tui truncates our output and the
	// bottom frame + footer disappear.
	return Math.max(1, Math.floor(termRows * OVERLAY_HEIGHT_PCT));
}

function frameRow(content: string, innerWidth: number): string {
	const padded = padToWidth(content, innerWidth);
	const sides = accent(FRAME.vertical);
	return `${sides} ${padded} ${sides}`;
}

function frameTopWithTitle(titleStyled: string, totalWidth: number): string {
	const titleVisible = visibleWidth(titleStyled);
	const inner = Math.max(2, totalWidth - 2);
	const titleFragment = ` ${titleStyled} `;
	const titleVisibleWithPad = titleVisible + 2;
	const remaining = Math.max(0, inner - titleVisibleWithPad);
	const leftPad = Math.min(2, remaining);
	const rightFill = Math.max(0, remaining - leftPad);
	const top = `${accent(FRAME.topLeft)}${accent(FRAME.horizontal.repeat(leftPad))}${titleFragment}${accent(FRAME.horizontal.repeat(rightFill))}${accent(FRAME.topRight)}`;
	return top;
}

function frameBottom(totalWidth: number): string {
	const inner = Math.max(0, totalWidth - 2);
	const bottom = `${accent(FRAME.bottomLeft)}${accent(FRAME.horizontal.repeat(inner))}${accent(FRAME.bottomRight)}`;
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
		return tab === active ? accentBold(`[${label}]`) : dim(` ${label} `);
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

function buildActionBar(): string {
	return ACTION_BAR_KEYS.map(({ key, label }) => `[${accentBold(key)}]${dim(label)}`).join(" ");
}

function firstFitting(width: number, candidates: string[]): string {
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? candidates[candidates.length - 1] ?? "";
}

function buildSelectedWorkerHeader(worker: WorkerRuntimeState | undefined, width: number): string {
	if (!worker) return firstFitting(width, ["selected: none · action: delegate new", "selected: none", "none"]);
	const attention = getWorkerAttentionDisplay(getWorkerAttentionPriority(worker)).label;
	const status = formatWorkerStatusLabel(worker);
	const action = getWorkerPrimaryAction(worker);
	return firstFitting(width, [
		`selected: ${worker.workerId} · ${worker.profileName} · ${status} · ${attention} · action: ${action}`,
		`selected: ${worker.workerId} · ${status} · action: ${action}`,
		`${worker.workerId} · ${status} · ${action}`,
		`${worker.workerId} · ${action}`,
	]);
}

function formatFollowHeader(following: boolean, top: number, visible: number, total: number): string {
	const start = total === 0 ? 0 : top + 1;
	const end = Math.min(total, top + visible);
	const status = following ? "[follow]" : "[paused f/G]";
	return `${status}  scroll ${start}-${end} / ${total}`;
}

function colorForGroup(group: WorkerAttentionGroup): (text: string) => string {
	switch (group) {
		case "needs_reply":
			return warning;
		case "needs_recovery":
			return danger;
		case "in_progress":
			return accent;
		case "completed_or_idle":
			return success;
	}
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
			return successBold;
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
			return worker.finalAnswer ? success : muted;
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
	getAssistantTail(workerId: string, fromIndex?: number): AssistantChunk[];
	onAssistantChunk?(listener: (workerId: string, chunk: AssistantChunk) => void): () => void;
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

export interface OpenTeamDashboardOptions {
	initialWorkerId?: string;
	cwd?: string;
	displayCost?: boolean;
	theme?: Theme;
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
		consoleScroll: 0,
		consoleFollow: true,
		costScroll: 0,
	};
	let statusMessage: string | undefined;
	let statusExpires = 0;
	let lastRenderMetrics: RenderMetrics = { layout: "stack", listPageSize: 8, bodyPageSize: 10 };

	const requestRender = () => {
		tui.requestRender?.();
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
		if ((state.tab === "console" && state.consoleFollow) || (state.tab === "inspect" && state.inspectFollow)) {
			requestRender();
		}
	});
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		offChunk?.();
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
		state.consoleScroll = 0;
		state.consoleFollow = true;
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
		state.consoleScroll = 0;
		state.consoleFollow = true;
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
		const body = wrapLines(buildInspectText(worker, teamManager.getWorkerTranscript(worker.workerId), currentPalette), width);
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

	const renderConsoleBody = (width: number, rows: number): string[] => {
		const worker = currentWorker();
		if (!worker) {
			return enforceWidth(["No worker selected. Switch to Workers (1) to pick one."], width).slice(0, rows);
		}
		const chunks = teamManager.getAssistantTail(worker.workerId);
		const events = teamManager.getWorkerConsole(worker.workerId) ?? [];
		const all = wrapLines(buildConsoleLines(worker, chunks, events).join("\n"), width);
		// Reserve 1 row for the [follow]/scroll header; the rest is the visible window.
		const visible = Math.max(1, rows - 1);
		const maxTop = Math.max(0, all.length - visible);
		if (state.consoleFollow) state.consoleScroll = maxTop;
		const top = clamp(state.consoleScroll, 0, maxTop);
		state.consoleScroll = top;
		lastRenderMetrics.bodyPageSize = visible;
		const header = formatFollowHeader(state.consoleFollow, top, visible, all.length);
		return enforceWidth([header, ...all.slice(top, top + visible)], width);
	};

	const renderCostBody = (width: number, rows: number): string[] => {
		const all = wrapLines(buildCostLines(snapshot).join("\n"), width);
		const maxTop = Math.max(0, all.length - rows);
		const top = Math.min(state.costScroll, maxTop);
		state.costScroll = top;
		lastRenderMetrics.bodyPageSize = rows;
		return enforceWidth(all.slice(top, top + rows), width);
	};

	const renderRosterPane = (_width: number, _rows: number): string[] => {
		// Split layout dropped: panel is always narrow (right-anchored 30%).
		return [];
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
		const roster = new RosterSelectList(snapshot, state.selectedWorkerId);
		const lines = roster.render(width);
		lastRenderMetrics.listPageSize = Math.max(1, rows - 1);
		return enforceWidth(lines, width).slice(0, rows);
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
			lastRenderMetrics.layout = "stack";
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
			const helpRow = state.tab === "workers"
				? firstFitting(innerWidth, [
					`↑/↓ select · space/b page · g/G ends · ${fullTabHint}`,
					`↑↓ select · space/b page · g/G · ${compactTabHint}`,
					`↑↓ select · space/b · g/G · ${compactTabHint}`,
				])
				: state.tab === "inspect"
					? firstFitting(innerWidth, [
						`↑/↓ scroll · f follow · space/b page · g/G top/bottom · ${fullTabHint}`,
						`↑↓ scroll · f follow · space/b · g/G · ${compactTabHint}`,
						`↑↓ · f · space/b · g/G · ${compactTabHint}`,
					])
					: state.tab === "console"
						? firstFitting(innerWidth, [
							`↑/↓ scroll · f follow · space/b page · g/G top/bottom · ${fullTabHint}`,
							`↑↓ scroll · f follow · space/b · g/G · ${compactTabHint}`,
							`↑↓ · f · space/b · g/G · ${compactTabHint}`,
						])
						: firstFitting(innerWidth, [
							`↑/↓ scroll · space/b page · g/G top/bottom · ${fullTabHint}`,
							`↑↓ scroll · space/b · g/G · ${compactTabHint}`,
							`↑↓ · space/b · g/G · ${compactTabHint}`,
						]);
			const worker = currentWorker();
			const workerCount = Object.keys(snapshot.activeWorkers).length;
			const attentionSummary = buildActionSummaryLine(snapshot);
			const summaryRow = firstFitting(innerWidth, [
				buildCompactTeamSummaryLine(snapshot),
				`workers ${workerCount} · ${attentionSummary}`,
				`workers ${workerCount} · ${attentionSummary.replace(/Needs /g, "").replace("Completed or idle", "Done/idle")}`,
				`${workerCount} workers · ${snapshot.relayQueue.length} relays`,
			]);
			const selectedHeader = buildSelectedWorkerHeader(worker, innerWidth);
			const snippet = worker ? buildWorkerPrioritySnippet(worker) : "no worker selected";
			const selectedSnippet = firstFitting(innerWidth, [
				`focus: ${snippet}`,
				snippet,
			]);
			const headerLines = [
				tabBar,
				accent(summaryRow),
				dim(helpRow),
				bold(selectedHeader),
				dim(selectedSnippet),
			];

			const footerLines: string[] = [];
			if (state.modal) {
				const inputLines = state.modal.input.render(innerWidth);
				const hint = dim("  (enter submit · esc cancel)");
				if (inputLines.length > 0) {
					const lastIndex = inputLines.length - 1;
					inputLines[lastIndex] = truncateToWidth(inputLines[lastIndex] + hint, innerWidth, "…");
				}
				footerLines.push(...inputLines.map((line) => accent(line)));
			}
			footerLines.push(buildActionBar());
			if (status) footerLines.push(accent(`» ${status}`));

			// Reserve rows: top frame (1) + header lines + blank + body + blank + footer + bottom frame (1).
			const overhead = 1 + headerLines.length + 1 + 1 + footerLines.length + 1;
			const bodyRows = Math.max(0, totalRows - overhead);

			const body = renderBody(innerWidth, bodyRows);
			while (body.length < bodyRows) body.push("");

			const innerLines = enforceWidth([...headerLines, "", ...body, "", ...footerLines], innerWidth);
			const framedRows = innerLines.map((line) => frameRow(line, innerWidth));
			const top = frameTopWithTitle(titleStyled, cap);
			const bottom = frameBottom(cap);
			const totalFrameRows = framedRows.length + 2;
			const tinyHint = totalFrameRows > totalRows ? frameRow(dim("(terminal too small)"), innerWidth) : undefined;
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
				refreshActive();
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
				if (isFollowToggleKey(data)) {
					state.consoleFollow = !state.consoleFollow;
					requestRender();
					return;
				}
				if (data === "j" || matchesKey(data, "down")) {
					state.consoleScroll += 1;
					state.consoleFollow = false;
					requestRender();
					return;
				}
				if (data === "k" || matchesKey(data, "up")) {
					state.consoleScroll = Math.max(0, state.consoleScroll - 1);
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

	if (!ctx.hasUI) {
		console.log(buildTeamDashboardText(initialState));
		return;
	}

	class DashboardLoader implements Component {
		private child: Component & { dispose?(): void; handleInput?(data: string): void };
		constructor(child: Component & { dispose?(): void; handleInput?(data: string): void }) {
			this.child = child;
		}
		replace(child: Component & { dispose?(): void; handleInput?(data: string): void }): void {
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
			this.child.dispose?.();
		}
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme as Theme, "Loading team dashboard…", { cancellable: false });
			const wrapper = new DashboardLoader(loader);
			teamManager.pingWorkers({ mode: "active" })
				.catch(() => {})
				.then(() => {
					const state = teamManager.snapshot();
					const resolvedFocusWorkerId = options.initialWorkerId && state.activeWorkers[options.initialWorkerId]
						? options.initialWorkerId
						: focusWorkerId;
					wrapper.replace(createTeamDashboardOverlayComponent(
						tui as TUI,
						teamManager as unknown as OverlayTeamManager,
						state,
						done,
						{ initialWorkerId: resolvedFocusWorkerId, cwd: options.cwd ?? ctx.cwd, displayCost: options.displayCost, theme },
					));
					tui.requestRender();
				});
			return wrapper;
		},
		{
			overlay: true,
			overlayOptions: TEAM_DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}

export { buildTeamDashboardText };
