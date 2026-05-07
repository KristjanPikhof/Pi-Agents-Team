import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TUI, OverlayOptions } from "@mariozechner/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import type { AssistantChunk, WorkerConsoleEvent } from "../runtime/worker-manager";
import { type PersistedTeamState, type WorkerRuntimeState, type WorkerStatus } from "../types";
import { copyToClipboard } from "../util/clipboard";
import { buildCopyPayload } from "./copy-payload";
import { buildRosterSections, buildTeamDashboardText, buildWorkerPrioritySnippet } from "./dashboard";

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

export const TEAM_DASHBOARD_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "right-center",
	width: "76%",
	minWidth: 60,
	maxHeight: "90%",
	margin: 1,
};

const WIDE_LAYOUT_MIN_WIDTH = 110;
const MIN_OVERLAY_ROWS = 14;
const MIN_BODY_ROWS = 6;

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
	return `turns=${worker.usage.turns}  in=${worker.usage.inputTokens}  out=${worker.usage.outputTokens}  cost=$${worker.usage.costUsd.toFixed(4)}`;
}

function buildInspectText(worker: WorkerRuntimeState, transcript: string | undefined): string {
	const lines = [
		`${worker.workerId} · ${worker.profileName} · ${worker.status}${REUSABLE_STATUSES.has(worker.status) ? "  [reusable]" : ""}`,
		"",
		"Status",
		`  ${formatUsage(worker)}`,
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
	if (workers.length === 0) return ["(no tracked workers)"];
	let totalTurns = 0;
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;
	const rows: string[] = [];
	for (const worker of workers) {
		totalTurns += worker.usage.turns;
		totalIn += worker.usage.inputTokens;
		totalOut += worker.usage.outputTokens;
		totalCost += worker.usage.costUsd;
		rows.push(
			`  ${worker.workerId.padEnd(6)} ${worker.profileName.padEnd(12)} turns=${worker.usage.turns}  in=${worker.usage.inputTokens}  out=${worker.usage.outputTokens}  cost=$${worker.usage.costUsd.toFixed(4)}`,
		);
	}
	return [
		`Σ workers=${workers.length}  turns=${totalTurns}  in=${totalIn}  out=${totalOut}  cost=$${totalCost.toFixed(4)}`,
		"",
		...rows,
	];
}

function getAttentionOrderedWorkerIds(state: PersistedTeamState): string[] {
	return buildRosterSections(state).flatMap((section) => section.workers.map((worker) => worker.workerId));
}

function buildRosterRow(worker: WorkerRuntimeState, selected: boolean, width: number): string {
	const prefix = selected ? "▶ " : "  ";
	const reuse = REUSABLE_STATUSES.has(worker.status) ? " [reuse]" : "";
	const text = `${prefix}${worker.workerId} · ${worker.profileName} · ${worker.status}${reuse} · ${buildWorkerPrioritySnippet(worker)}`;
	return truncateToWidth(text, width, "…");
}

function wrapLines(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const raw of text.split("\n")) {
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
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

function padToWidth(line: string, width: number): string {
	const truncated = visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
	const padding = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(padding);
}

function computeOverlayRows(termRows: number): number {
	return Math.max(MIN_OVERLAY_ROWS, Math.min(Math.max(1, termRows - 2), Math.floor(termRows * 0.9)));
}

function computeLayoutMode(termWidth: number): LayoutMode {
	return termWidth >= WIDE_LAYOUT_MIN_WIDTH ? "split" : "stack";
}

export function buildTabBar(active: OverlayTab, routingMode: "team" | "solo"): string {
	const cells = TAB_ORDER.map((tab, index) => {
		const num = index + 1;
		const label = `${num} ${TAB_LABELS[tab]}`;
		return tab === active ? `[${label}]` : ` ${label} `;
	});
	const badge = routingMode === "solo" ? "  · solo" : "";
	return cells.join("  ") + badge;
}

const ACTION_BAR = "[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit";

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
}

export interface OpenTeamDashboardOptions {
	initialWorkerId?: string;
	cwd?: string;
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
	let snapshot = initialSnapshot;
	const initialWorker = options.initialWorkerId && initialSnapshot.activeWorkers[options.initialWorkerId]
		? options.initialWorkerId
		: undefined;
	const state: DashboardState = {
		tab: initialWorker ? "inspect" : "workers",
		selectedWorkerId: initialWorker,
		inspectScroll: 0,
		consoleScroll: 0,
		consoleFollow: true,
		costScroll: 0,
	};
	let statusMessage: string | undefined;
	let statusExpires = 0;
	let lastRenderMetrics: RenderMetrics = { layout: computeLayoutMode(tui.terminal.columns), listPageSize: 8, bodyPageSize: 10 };

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
		if (state.tab === "console" && state.selectedWorkerId === workerId && state.consoleFollow) {
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
			if (kind === "steer" && worker.status !== "running") {
				setStatus("Steer needs a running worker; use [m]sg for idle/waiting workers");
				return;
			}
			if (TERMINAL_STATUSES.has(worker.status) && worker.status !== "idle" && worker.status !== "waiting_followup" && kind === "message") {
				setStatus(`Worker ${workerId} is ${worker.status} — cannot message`);
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
		const maxTop = Math.max(0, body.length - rows);
		const top = Math.min(state.inspectScroll, maxTop);
		state.inspectScroll = top;
		lastRenderMetrics.bodyPageSize = rows;
		return enforceWidth(body.slice(top, top + rows), width);
	};

	const renderConsoleBody = (width: number, rows: number): string[] => {
		const worker = currentWorker();
		if (!worker) {
			return enforceWidth(["No worker selected. Switch to Workers (1) to pick one."], width).slice(0, rows);
		}
		const chunks = teamManager.getAssistantTail(worker.workerId);
		const events = teamManager.getWorkerConsole(worker.workerId) ?? [];
		const all = wrapLines(buildConsoleLines(worker, chunks, events).join("\n"), width);
		const maxTop = Math.max(0, all.length - rows);
		if (state.consoleFollow) state.consoleScroll = maxTop;
		const top = clamp(state.consoleScroll, 0, maxTop);
		state.consoleScroll = top;
		lastRenderMetrics.bodyPageSize = rows;
		const followTag = state.consoleFollow ? "[follow]" : "[paused — End to follow]";
		const header = `${followTag}  scroll ${all.length === 0 ? 0 : top + 1}-${Math.min(all.length, top + rows)} / ${all.length}`;
		return enforceWidth([header, ...all.slice(top, top + Math.max(0, rows - 1))], width);
	};

	const renderCostBody = (width: number, rows: number): string[] => {
		const all = wrapLines(buildCostLines(snapshot).join("\n"), width);
		const maxTop = Math.max(0, all.length - rows);
		const top = Math.min(state.costScroll, maxTop);
		state.costScroll = top;
		lastRenderMetrics.bodyPageSize = rows;
		return enforceWidth(all.slice(top, top + rows), width);
	};

	const renderRosterPane = (width: number, rows: number): string[] => {
		const lines: string[] = ["Workers"];
		for (const section of buildRosterSections(snapshot)) {
			if (section.workers.length === 0) continue;
			lines.push(`${section.label} (${section.workers.length})`);
			for (const worker of section.workers) {
				lines.push(buildRosterRow(worker, worker.workerId === state.selectedWorkerId, width));
			}
		}
		if (lines.length === 1) lines.push("(none)");
		return enforceWidth(lines, width).slice(0, rows);
	};

	const renderBody = (width: number, rows: number): string[] => {
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
			lines.push(`${section.label} (${section.workers.length})`);
			for (const worker of section.workers) {
				lines.push(buildRosterRow(worker, worker.workerId === state.selectedWorkerId, width));
			}
			lines.push("");
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		if (lines.length === 0) lines.push("No tracked workers. Press [n] to delegate one.");
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
		state.modal.buffer += data;
		return true;
	};

	const handleNumberKey = (data: string): boolean => {
		const idx = ["1", "2", "3", "4"].indexOf(data);
		if (idx < 0) return false;
		state.tab = TAB_ORDER[idx];
		return true;
	};

	return {
		render(width: number): string[] {
			refreshSnapshot();
			const layout = computeLayoutMode(width);
			lastRenderMetrics.layout = layout;
			const overlayRows = computeOverlayRows(tui.terminal.rows);
			const routingMode = teamManager.routingMode ?? "team";
			const status = activeStatus();
			const tabBar = buildTabBar(state.tab, routingMode);
			const helpRow = state.tab === "workers"
				? "↑/↓ select · enter inspect · 1-4 tabs · tab/shift-tab cycle · q quit"
				: state.tab === "inspect"
					? "↑/↓ scroll · PgUp/PgDn page · 1-4 tabs · q quit"
					: state.tab === "console"
						? "↑/↓ scroll · PgUp pause · End follow · 1-4 tabs · q quit"
						: "↑/↓ scroll · 1-4 tabs · q quit";
			const subHeader = `selected=${state.selectedWorkerId ?? "none"}  ·  ${currentWorker() ? buildWorkerPrioritySnippet(currentWorker()!) : "no worker selected"}`;
			const header = [
				"Pi Agents Team · /team",
				tabBar,
				helpRow,
				subHeader,
			];

			const footerLines: string[] = [];
			if (state.modal) {
				footerLines.push(`${state.modal.label}${state.modal.buffer}_  (enter submit · esc cancel)`);
			}
			footerLines.push(ACTION_BAR);
			if (status) footerLines.push(`» ${status}`);

			const bodyRows = Math.max(MIN_BODY_ROWS, overlayRows - header.length - footerLines.length - 1);

			let body: string[];
			if (layout === "split" && (state.tab === "inspect" || state.tab === "console")) {
				const listWidth = clamp(Math.floor(width * 0.34), 28, Math.max(28, width - 36));
				const separator = " │ ";
				const detailWidth = Math.max(24, width - listWidth - visibleWidth(separator));
				const listLines = renderRosterPane(listWidth, bodyRows);
				const detailLines = state.tab === "inspect"
					? renderInspectBody(detailWidth, bodyRows)
					: renderConsoleBody(detailWidth, bodyRows);
				const rowCount = Math.max(listLines.length, detailLines.length, bodyRows);
				body = [];
				for (let i = 0; i < rowCount; i += 1) {
					body.push(`${padToWidth(listLines[i] ?? "", listWidth)}${separator}${padToWidth(detailLines[i] ?? "", detailWidth)}`);
				}
			} else {
				body = renderBody(width, bodyRows);
			}

			return enforceWidth([...header, "", ...body, "", ...footerLines], width);
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
				const idx = TAB_ORDER.indexOf(state.tab);
				state.tab = TAB_ORDER[(idx + 1) % TAB_ORDER.length];
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				const idx = TAB_ORDER.indexOf(state.tab);
				state.tab = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length];
				return;
			}

			// Legacy hotkeys mapped to nearest new tab. Tip surfaced in help row.
			if (state.tab === "workers" || state.tab === "inspect") {
				if (data === "o") { state.tab = "inspect"; return; }
				if (data === "d") { state.tab = "inspect"; return; }
			}
			if (data !== "c" && (state.tab === "workers" || state.tab === "inspect" || state.tab === "console") && data === "C") {
				state.tab = "console";
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
			{ initialWorkerId: focusWorkerId, cwd: options.cwd ?? ctx.cwd },
		),
		{
			overlay: true,
			overlayOptions: TEAM_DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}

export { buildTeamDashboardText };
