import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI, OverlayOptions } from "@earendil-works/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import type { AssistantChunk, WorkerConsoleEvent } from "../runtime/worker-manager";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";
import { aggregateWorkerUsage, hasWorkerUsage } from "../usage";
import { copyToClipboard } from "../util/clipboard";
import { buildCopyPayload } from "./copy-payload";
import { buildRosterSections, buildTeamDashboardText, buildWorkerPrioritySnippet, type WorkerAttentionGroup, getWorkerAttentionGroup } from "./dashboard";
import { formatCompactTokenCount, formatContextBudget } from "./usage-format";
import {
	accent,
	accentBold,
	bold,
	danger,
	dangerBold,
	dim,
	FRAME,
	muted,
	success,
	successBold,
	warning,
	warningBold,
} from "./theme";

type OverlayTab = "workers" | "inspect" | "console" | "cost";
type LayoutMode = "stack" | "split";
type ModalKind = "steer" | "message" | "new_task";

interface ModalState {
	kind: ModalKind;
	label: string;
	buffer: string;
	workerId?: string;
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
	lines.push(label);
	for (const value of values) lines.push(`  ${value}`);
}

function formatUsage(worker: WorkerRuntimeState): string {
	const base = `turns=${worker.usage.turns}  in=${formatCompactTokenCount(worker.usage.inputTokens)}  out=${formatCompactTokenCount(worker.usage.outputTokens)}  cost=$${worker.usage.costUsd.toFixed(4)}`;
	const contextBudget = formatContextBudget(worker.usage);
	return contextBudget ? `${base}  ${contextBudget}` : base;
}

function hasClampedThinking(worker: WorkerRuntimeState): boolean {
	return worker.requestedThinkingLevel !== worker.effectiveThinkingLevel;
}

function formatThinking(worker: WorkerRuntimeState): string {
	if (!hasClampedThinking(worker)) return worker.effectiveThinkingLevel;
	return warning(`${worker.requestedThinkingLevel} -> ${worker.effectiveThinkingLevel} (clamped)`);
}

function formatRosterProfileName(worker: WorkerRuntimeState): string {
	return `${worker.profileName}${hasClampedThinking(worker) ? " (clamped)" : ""}`;
}

function buildInspectText(worker: WorkerRuntimeState, transcript: string | undefined): string {
	const lines = [
		`${worker.workerId} · ${worker.profileName} · ${worker.status}${REUSABLE_STATUSES.has(worker.status) ? "  [reusable]" : ""}`,
		"",
		"Status",
		`  ${formatUsage(worker)}`,
		`  Thinking: ${formatThinking(worker)}`,
	];
	if (worker.lastToolName) lines.push(`  last tool: ${worker.lastToolName}`);
	if (worker.error) lines.push(`  error: ${worker.error}`);

	lines.push("", "Task");
	if (worker.currentTask) {
		lines.push(`  ${worker.currentTask.title}`);
		if (worker.currentTask.goal) lines.push(`  goal: ${worker.currentTask.goal}`);
		if (worker.currentTask.expectedOutput) lines.push(`  expected: ${worker.currentTask.expectedOutput}`);
		appendList(lines, "  context:", worker.currentTask.contextHints);
		if (worker.currentTask.pathScope) appendList(lines, "  path scope:", worker.currentTask.pathScope.roots);
	} else {
		lines.push("  (none)");
	}

	lines.push("", "Needs operator");
	if (worker.pendingRelayQuestions.length === 0) {
		lines.push("  (none)");
	} else {
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`  [${relay.urgency}] ${relay.question}`);
			lines.push(`    assumption: ${relay.assumption}`);
		}
	}

	lines.push("", "Summary");
	if (worker.lastSummary) {
		lines.push(`  ${worker.lastSummary.headline}`);
		appendList(lines, "  read files:", worker.lastSummary.readFiles);
		appendList(lines, "  changed files:", worker.lastSummary.changedFiles);
		appendList(lines, "  risks:", worker.lastSummary.risks);
		if (worker.lastSummary.nextRecommendation) lines.push(`  next: ${worker.lastSummary.nextRecommendation}`);
	} else {
		lines.push("  (no summary captured yet)");
	}

	lines.push("", "Final answer");
	lines.push(worker.finalAnswer?.trim() || "  (no <final_answer> block produced)");

	lines.push("", "Latest assistant text");
	lines.push(transcript?.trim() || "  (no assistant text captured)");
	return lines.join("\n");
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `[${formatTimestamp(event.ts)}] [${event.kind}] ${event.text}`;
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
	for (const chunk of chunks) {
		const text = chunk.text.replace(/\r/g, "");
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i += 1) {
			const prefix = i === 0 ? `[${formatTimestamp(chunk.ts)}] ` : "    ";
			lines.push(`${prefix}${parts[i]}`);
		}
	}
	if (consoleEvents.length > 0) {
		lines.push("", "— events —");
		for (const event of consoleEvents) lines.push(formatConsoleEvent(event));
	}
	return lines;
}

function buildCostLines(state: PersistedTeamState): string[] {
	const workers = Object.values(state.activeWorkers);
	const total = aggregateWorkerUsage(workers, state.prunedWorkerUsageTotals);
	const retained = state.prunedWorkerUsageTotals;
	if (workers.length === 0 && !hasWorkerUsage(retained)) return ["(no tracked workers)"];
	const rows: string[] = [];
	if (hasWorkerUsage(retained)) {
		rows.push(
			`retained/pruned: workers=${retained.workers}  turns=${retained.turns}  in=${formatCompactTokenCount(retained.inputTokens)}  out=${formatCompactTokenCount(retained.outputTokens)}  cost=$${retained.costUsd.toFixed(4)}`,
		);
	}
	for (const worker of workers) {
		rows.push(
			`  ${worker.workerId.padEnd(6)} ${worker.profileName.padEnd(12)} turns=${worker.usage.turns}  in=${formatCompactTokenCount(worker.usage.inputTokens)}  out=${formatCompactTokenCount(worker.usage.outputTokens)}  cost=$${worker.usage.costUsd.toFixed(4)}`,
		);
	}
	return [
		`Σ workers=${total.workers}  turns=${total.turns}  in=${formatCompactTokenCount(total.inputTokens)}  out=${formatCompactTokenCount(total.outputTokens)}  cost=$${total.costUsd.toFixed(4)}`,
		"",
		...(rows.length > 0 ? rows : ["(no tracked workers)"]),
	];
}

function getAttentionOrderedWorkerIds(state: PersistedTeamState): string[] {
	return buildRosterSections(state).flatMap((section) => section.workers.map((worker) => worker.workerId));
}

function buildRosterRow(worker: WorkerRuntimeState, selected: boolean, width: number): string {
	const prefix = selected ? "▶ " : "  ";
	const reuse = REUSABLE_STATUSES.has(worker.status) ? " [reuse]" : "";
	const head = `${prefix}${worker.workerId} · ${formatRosterProfileName(worker)} · ${worker.status}${reuse}`;
	const tail = ` · ${buildWorkerPrioritySnippet(worker)}`;
	const truncated = truncateToWidth(`${head}${tail}`, width, "…");
	const color = colorForWorker(worker);
	if (selected) return color(bold(truncated));
	return color(truncated);
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

function wrapLines(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const raw of sanitizeText(text).split("\n")) {
		if (visibleWidth(raw) <= width) {
			out.push(raw);
			continue;
		}
		let remaining = raw;
		let guard = 0;
		while (visibleWidth(remaining) > width && guard < 1000) {
			const head = truncateToWidth(remaining, width, "");
			out.push(head);
			remaining = remaining.slice(head.length);
			guard += 1;
		}
		if (remaining.length > 0) out.push(remaining);
	}
	return out;
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
	messageWorker?(workerId: string, message: string, delivery?: "auto" | "steer" | "follow_up"): Promise<unknown>;
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
			.then(() => setStatus(`Copied ${worker.workerId} (${payload.length.toLocaleString()} chars)`))
			.catch((error) => setStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, 4000));
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
			state.modal = {
				kind,
				label: kind === "steer" ? `Steer ${workerId}: ` : `Message ${workerId}: `,
				buffer: "",
				workerId,
			};
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
		state.modal = {
			kind: "new_task",
			label: `New task (${profile}): `,
			buffer: "",
			workerId: currentWorker()?.workerId,
		};
	};

	const submitModal = async () => {
		const modal = state.modal;
		if (!modal) return;
		const trimmed = modal.buffer.trim();
		state.modal = undefined;
		if (!trimmed) {
			setStatus("(empty input — cancelled)");
			return;
		}
		try {
			if (modal.kind === "steer" && modal.workerId) {
				await teamManager.messageWorker?.(modal.workerId, trimmed, "steer");
				setStatus(`Steered ${modal.workerId}`);
			} else if (modal.kind === "message" && modal.workerId) {
				await teamManager.messageWorker?.(modal.workerId, trimmed, "auto");
				setStatus(`Sent message to ${modal.workerId}`);
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
				setStatus(`Delegated new task to ${profile}`);
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
			setStatus(`Closed ${worker.workerId}`);
		} catch (error) {
			setStatus(`Close failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
		}
	};
	const cancelSelected = async () => {
		const worker = currentWorker();
		if (!worker) return setStatus("No worker selected");
		try {
			await teamManager.cancelWorker?.(worker.workerId);
			setStatus(`Cancelled ${worker.workerId}`);
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
		const body = wrapLines(buildInspectText(worker, teamManager.getWorkerTranscript(worker.workerId)), width);
		// Reserve 1 row for the [follow]/scroll header; the rest is the visible window.
		const visible = Math.max(1, rows - 1);
		const maxTop = Math.max(0, body.length - visible);
		if (state.inspectFollow) state.inspectScroll = maxTop;
		const top = clamp(state.inspectScroll, 0, maxTop);
		state.inspectScroll = top;
		lastRenderMetrics.bodyPageSize = visible;
		const followTag = state.inspectFollow ? "[follow]" : "[paused — f/G to follow]";
		const header = `${followTag}  scroll ${body.length === 0 ? 0 : top + 1}-${Math.min(body.length, top + visible)} / ${body.length}`;
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
		const followTag = state.consoleFollow ? "[follow]" : "[paused — f/G to follow]";
		const header = `${followTag}  scroll ${all.length === 0 ? 0 : top + 1}-${Math.min(all.length, top + visible)} / ${all.length}`;
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
		const lines: string[] = [];
		for (const section of buildRosterSections(snapshot)) {
			if (section.workers.length === 0) continue;
			const label = `${section.label} (${section.workers.length})`;
			lines.push(colorForGroupBold(section.key)(label));
			for (const worker of section.workers) {
				lines.push(buildRosterRow(worker, worker.workerId === state.selectedWorkerId, width));
			}
			lines.push("");
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		if (lines.length === 0) lines.push(dim("No tracked workers. Press [n] to delegate one."));
		lastRenderMetrics.listPageSize = Math.max(1, rows - 1);
		return enforceWidth(lines, width).slice(0, rows);
	}

	ensureSelectedWorker();

	const handleModalInput = (data: string): boolean => {
		if (!state.modal) return false;
		if (matchesKey(data, "escape")) {
			state.modal = undefined;
			setStatus("(cancelled)");
			return true;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			void submitModal();
			return true;
		}
		if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
			state.modal.buffer = state.modal.buffer.slice(0, -1);
			return true;
		}
		// Reject control sequences other than printable ASCII / unicode.
		if (data.length === 1 && data.charCodeAt(0) < 0x20) return true;
		if (data.startsWith("\x1b")) return true;
		const printable = data
			.replace(/[\r\n]+/g, " ")
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
		if (printable.length > 0) state.modal.buffer += printable;
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
			const tabHint = displayCost ? "1-4 tabs" : "1-3 tabs";
			const helpRow = state.tab === "workers"
				? `↑/↓ select · enter inspect · ${tabHint} · tab cycle · q quit`
				: state.tab === "inspect"
					? `↑/↓ scroll · PgUp/PgDn page · ${tabHint} · q quit`
					: state.tab === "console"
						? `↑/↓ scroll · PgUp pause · End follow · ${tabHint} · q quit`
						: `↑/↓ scroll · ${tabHint} · q quit`;
			const sel = state.selectedWorkerId ?? "none";
			const snippet = currentWorker() ? buildWorkerPrioritySnippet(currentWorker()!) : "no worker selected";
			const subHeader = `selected=${sel}  ·  ${snippet}`;
			const headerLines = [
				tabBar,
				dim(helpRow),
				dim(subHeader),
			];

			const footerLines: string[] = [];
			if (state.modal) {
				footerLines.push(accent(`${state.modal.label}${state.modal.buffer}_`) + dim("  (enter submit · esc cancel)"));
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
			return [top, ...framedRows, bottom];
		},
		invalidate() {},
		dispose() {
			dispose();
		},
		handleInput(data: string) {
			if (handleModalInput(data)) return;

			if (data === "q") return finish();
			if (matchesKey(data, "escape")) return finish();

			if (handleNumberKey(data)) return;
			if (matchesKey(data, "tab")) {
				const idx = visibleTabOrder.indexOf(state.tab);
				state.tab = visibleTabOrder[(idx + 1) % visibleTabOrder.length]!;
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				const idx = visibleTabOrder.indexOf(state.tab);
				state.tab = visibleTabOrder[(idx - 1 + visibleTabOrder.length) % visibleTabOrder.length]!;
				return;
			}

			// Legacy `o` / `d` aliases land you on Inspect (the merged Overview/Deliverable view).
			// `c` is no longer the Console alias — it's the action-bar close hotkey.
			if (data === "o" || data === "d") {
				state.tab = "inspect";
				return;
			}

			// Action bar hotkeys.
			if (data === "s") return openModal("steer", state.selectedWorkerId);
			if (data === "m") return openModal("message", state.selectedWorkerId);
			if (data === "n") return openModal("new_task");
			if (data === "c") return void closeSelected();
			if (data === "x") return void cancelSelected();
			if (data === "p") return void pruneTerminal();
			if (data === "r") return refreshActive();
			if (data === "y") return copyCurrent();

			// List/scroll navigation per tab.
			if (state.tab === "workers") {
				if (data === "j" || matchesKey(data, "down")) return moveSelection(1);
				if (data === "k" || matchesKey(data, "up")) return moveSelection(-1);
				if (matchesKey(data, "pageDown")) return moveSelection(lastRenderMetrics.listPageSize);
				if (matchesKey(data, "pageUp")) return moveSelection(-lastRenderMetrics.listPageSize);
				if (matchesKey(data, "enter")) {
					if (state.selectedWorkerId) state.tab = "inspect";
					return;
				}
				if (data === "g" || matchesKey(data, "home")) {
					const ids = getAttentionOrderedWorkerIds(snapshot);
					if (ids.length > 0) state.selectedWorkerId = ids[0];
					return;
				}
				if (data === "G" || matchesKey(data, "end")) {
					const ids = getAttentionOrderedWorkerIds(snapshot);
					if (ids.length > 0) state.selectedWorkerId = ids[ids.length - 1];
					return;
				}
				return;
			}

			if (state.tab === "inspect") {
				if (data === "j" || matchesKey(data, "down")) { state.inspectScroll += 1; return; }
				if (data === "k" || matchesKey(data, "up")) { state.inspectScroll = Math.max(0, state.inspectScroll - 1); return; }
				if (matchesKey(data, "pageDown")) { state.inspectScroll += lastRenderMetrics.bodyPageSize; return; }
				if (matchesKey(data, "pageUp")) { state.inspectScroll = Math.max(0, state.inspectScroll - lastRenderMetrics.bodyPageSize); return; }
				if (data === "g" || matchesKey(data, "home")) { state.inspectScroll = 0; return; }
				if (data === "G" || matchesKey(data, "end")) { state.inspectScroll = Number.MAX_SAFE_INTEGER; return; }
				return;
			}

			if (state.tab === "console") {
				if (data === "j" || matchesKey(data, "down")) {
					state.consoleScroll += 1;
					state.consoleFollow = false;
					return;
				}
				if (data === "k" || matchesKey(data, "up")) {
					state.consoleScroll = Math.max(0, state.consoleScroll - 1);
					state.consoleFollow = false;
					return;
				}
				if (matchesKey(data, "pageUp")) {
					state.consoleScroll = Math.max(0, state.consoleScroll - lastRenderMetrics.bodyPageSize);
					state.consoleFollow = false;
					return;
				}
				if (matchesKey(data, "pageDown")) {
					state.consoleScroll += lastRenderMetrics.bodyPageSize;
					return;
				}
				if (matchesKey(data, "end") || data === "G") {
					state.consoleFollow = true;
					return;
				}
				if (matchesKey(data, "home") || data === "g") {
					state.consoleScroll = 0;
					state.consoleFollow = false;
					return;
				}
				return;
			}

			if (state.tab === "cost") {
				if (data === "j" || matchesKey(data, "down")) { state.costScroll += 1; return; }
				if (data === "k" || matchesKey(data, "up")) { state.costScroll = Math.max(0, state.costScroll - 1); return; }
				if (matchesKey(data, "pageDown")) { state.costScroll += lastRenderMetrics.bodyPageSize; return; }
				if (matchesKey(data, "pageUp")) { state.costScroll = Math.max(0, state.costScroll - lastRenderMetrics.bodyPageSize); return; }
				if (data === "g" || matchesKey(data, "home")) { state.costScroll = 0; return; }
				if (data === "G" || matchesKey(data, "end")) { state.costScroll = Number.MAX_SAFE_INTEGER; return; }
			}
		},
	};
}

export async function openTeamDashboardOverlay(
	ctx: ExtensionContext,
	teamManager: TeamManager,
	options: OpenTeamDashboardOptions = {},
): Promise<void> {
	try {
		await teamManager.pingWorkers({ mode: "active" });
	} catch {}
	const state = teamManager.snapshot();
	const focusWorkerId = options.initialWorkerId && state.activeWorkers[options.initialWorkerId]
		? options.initialWorkerId
		: undefined;

	if (!ctx.hasUI) {
		console.log(buildTeamDashboardText(state));
		return;
	}

	await ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => createTeamDashboardOverlayComponent(
			tui as TUI,
			teamManager as unknown as OverlayTeamManager,
			state,
			done,
			{ initialWorkerId: focusWorkerId, cwd: options.cwd ?? ctx.cwd, displayCost: options.displayCost },
		),
		{
			overlay: true,
			overlayOptions: TEAM_DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}

export { buildTeamDashboardText };
