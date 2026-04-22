import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TUI, OverlayOptions } from "@mariozechner/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import type { WorkerConsoleEvent } from "../runtime/worker-manager";
import { type PersistedTeamState, type WorkerRuntimeState } from "../types";
import { copyToClipboard } from "../util/clipboard";
import { buildCopyPayload } from "./copy-payload";
import { buildActionSummaryLine, buildRosterSections, buildTeamDashboardText, buildWorkerPrioritySnippet } from "./dashboard";

type DetailTab = "overview" | "deliverable" | "console";
type PaneFocus = "list" | "detail";
type LayoutMode = "stack" | "split";
type NarrowView = "list" | "detail";

interface DashboardState {
	selectedWorkerId?: string;
	paneFocus: PaneFocus;
	narrowView: NarrowView;
	detailTab: DetailTab;
	detailScrollTop: number;
}

interface RenderMetrics {
	layout: LayoutMode;
	listPageSize: number;
	detailPageSize: number;
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
const MIN_OVERLAY_ROWS = 12;
const MIN_LIST_ROWS = 6;
const MIN_DETAIL_ROWS = 6;

function formatUsage(worker: WorkerRuntimeState): string {
	return `turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens} cost=$${worker.usage.costUsd.toFixed(4)}`;
}

function appendList(lines: string[], label: string, values: string[]): void {
	if (values.length === 0) return;
	lines.push(label);
	for (const value of values) lines.push(`- ${value}`);
}

function buildOverviewText(worker: WorkerRuntimeState): string {
	const lines = ["Overview", "", "Status"];
	lines.push(`- Worker: ${worker.workerId}`);
	lines.push(`- Profile: ${worker.profileName}`);
	lines.push(`- Status: ${worker.status}`);
	lines.push(`- Deliverable ready: ${worker.finalAnswer?.trim() ? "yes" : "not yet"}`);
	if (worker.lastToolName) lines.push(`- Last tool: ${worker.lastToolName}`);
	if (worker.error) lines.push(`- Error: ${worker.error}`);

	lines.push("", "Usage", `- ${formatUsage(worker)}`);

	lines.push("", "Task");
	if (worker.currentTask) {
		lines.push(`- Title: ${worker.currentTask.title}`);
		lines.push(`- Goal: ${worker.currentTask.goal}`);
		if (worker.currentTask.expectedOutput) lines.push(`- Expected output: ${worker.currentTask.expectedOutput}`);
		appendList(lines, "Context hints", worker.currentTask.contextHints);
		if (worker.currentTask.pathScope) appendList(lines, "Path scope", worker.currentTask.pathScope.roots);
	} else {
		lines.push("- No task assigned.");
	}

	lines.push("", "Needs operator");
	if (worker.pendingRelayQuestions.length === 0) {
		lines.push("- None.");
	} else {
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
			lines.push(`  assumption: ${relay.assumption}`);
		}
	}

	lines.push("", "Latest summary");
	if (worker.lastSummary) {
		lines.push(`- Headline: ${worker.lastSummary.headline}`);
		appendList(lines, "Read files", worker.lastSummary.readFiles);
		appendList(lines, "Changed files", worker.lastSummary.changedFiles);
		appendList(lines, "Risks", worker.lastSummary.risks);
		if (worker.lastSummary.nextRecommendation) lines.push(`- Next recommendation: ${worker.lastSummary.nextRecommendation}`);
	} else {
		lines.push("- No summary captured yet.");
	}

	return lines.join("\n");
}

function buildDeliverableText(worker: WorkerRuntimeState, transcript: string | undefined): string {
	const lines = ["Deliverable", "", "Final answer", worker.finalAnswer?.trim() || "(no <final_answer> block produced)"];
	lines.push("", "Supporting artifacts");
	if (worker.lastSummary?.headline) lines.push(`- Headline: ${worker.lastSummary.headline}`);
	appendList(lines, "Changed files", worker.lastSummary?.changedFiles ?? []);
	appendList(lines, "Read files", worker.lastSummary?.readFiles ?? []);
	appendList(lines, "Risks", worker.lastSummary?.risks ?? []);
	if (worker.lastSummary?.nextRecommendation) lines.push(`- Next recommendation: ${worker.lastSummary.nextRecommendation}`);
	if (worker.error) lines.push(`- Error: ${worker.error}`);
	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("Pending relay questions");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
		}
	}
	lines.push("", "Latest assistant text", transcript?.trim() || "(no assistant text captured)");
	return lines.join("\n");
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function formatConsoleEvent(event: WorkerConsoleEvent): string {
	return `[${formatTimestamp(event.ts)}] [${event.kind}] ${event.text}`;
}

function buildConsoleText(worker: WorkerRuntimeState, events: WorkerConsoleEvent[] | undefined): string {
	const header = [
		`Console — ${worker.workerId} (${worker.profileName}) · status=${worker.status}`,
		`Events captured: ${events?.length ?? 0}`,
		"",
	];
	if (!events || events.length === 0) {
		return [...header, "No events recorded yet."].join("\n");
	}
	return [...header, ...events.map(formatConsoleEvent)].join("\n");
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

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function cycleTab(tab: DetailTab, direction: 1 | -1): DetailTab {
	const tabs: DetailTab[] = ["overview", "deliverable", "console"];
	const index = tabs.indexOf(tab);
	return tabs[(index + direction + tabs.length) % tabs.length] ?? tab;
}

function computeOverlayRows(termRows: number): number {
	return Math.max(MIN_OVERLAY_ROWS, Math.min(Math.max(1, termRows - 2), Math.floor(termRows * 0.9)));
}

function computeLayoutMode(termWidth: number): LayoutMode {
	return termWidth >= WIDE_LAYOUT_MIN_WIDTH ? "split" : "stack";
}

function getAttentionOrderedWorkerIds(state: PersistedTeamState): string[] {
	return buildRosterSections(state).flatMap((section) => section.workers.map((worker) => worker.workerId));
}

function buildRosterRow(worker: WorkerRuntimeState, selected: boolean, width: number): string {
	const prefix = selected ? "▶ " : "  ";
	const text = `${prefix}${worker.workerId} · ${worker.profileName} · ${buildWorkerPrioritySnippet(worker)}`;
	return truncateToWidth(text, width, "…");
}

export interface OpenTeamDashboardOptions {
	initialWorkerId?: string;
}

export function createTeamDashboardOverlayComponent(
	tui: OverlayLikeTui,
	teamManager: TeamManager,
	initialSnapshot: PersistedTeamState,
	done: () => void,
	options: OpenTeamDashboardOptions = {},
): {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
} {
	let snapshot = initialSnapshot;
	const state: DashboardState = {
		selectedWorkerId: options.initialWorkerId && initialSnapshot.activeWorkers[options.initialWorkerId]
			? options.initialWorkerId
			: undefined,
		paneFocus: options.initialWorkerId ? "detail" : "list",
		narrowView: options.initialWorkerId ? "detail" : "list",
		detailTab: "overview",
		detailScrollTop: 0,
	};
	let statusMessage: string | undefined;
	let statusExpires = 0;
	let lastRenderMetrics: RenderMetrics = { layout: computeLayoutMode(tui.terminal.columns), listPageSize: 8, detailPageSize: 10 };

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

	const setSelectedWorker = (workerId: string | undefined, resetScroll = false) => {
		state.selectedWorkerId = workerId;
		if (workerId && resetScroll) state.detailScrollTop = 0;
	};

	const ensureSelectedWorker = () => {
		const selectableWorkerIds = getAttentionOrderedWorkerIds(snapshot);
		if (selectableWorkerIds.length === 0) {
			state.selectedWorkerId = undefined;
			state.paneFocus = "list";
			state.narrowView = "list";
			return;
		}
		if (state.selectedWorkerId && snapshot.activeWorkers[state.selectedWorkerId]) return;
		setSelectedWorker(selectableWorkerIds[0], true);
	};

	const refreshSnapshot = () => {
		snapshot = teamManager.snapshot();
		ensureSelectedWorker();
	};

	const currentWorker = (): WorkerRuntimeState | undefined => {
		if (!state.selectedWorkerId) return undefined;
		return snapshot.activeWorkers[state.selectedWorkerId];
	};

	const moveListSelection = (delta: number) => {
		const workerIds = getAttentionOrderedWorkerIds(snapshot);
		if (workerIds.length === 0) return;
		const currentIndex = state.selectedWorkerId ? workerIds.indexOf(state.selectedWorkerId) : 0;
		const safeIndex = currentIndex >= 0 ? currentIndex : 0;
		const nextIndex = clamp(safeIndex + delta, 0, workerIds.length - 1);
		setSelectedWorker(workerIds[nextIndex], true);
	};

	const jumpListSelection = (target: "first" | "last") => {
		const workerIds = getAttentionOrderedWorkerIds(snapshot);
		if (workerIds.length === 0) return;
		setSelectedWorker(target === "first" ? workerIds[0] : workerIds[workerIds.length - 1], true);
	};

	const refreshActive = () => {
		teamManager.pingWorkers({ mode: "active" })
			.then(() => {
				refreshSnapshot();
				setStatus(`Refreshed ${Object.keys(snapshot.activeWorkers).length} tracked workers`);
			})
			.catch((error) => {
				setStatus(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`, 4000);
			});
	};

	const copyCurrentDetail = () => {
		const worker = currentWorker();
		if (!worker) {
			setStatus("Worker no longer tracked — nothing to copy");
			return;
		}
		const payload = buildCopyPayload(
			worker,
			teamManager.getWorkerTranscript(worker.workerId),
			teamManager.getWorkerConsole(worker.workerId),
		);
		copyToClipboard(payload)
			.then(() => setStatus(`Copied ${worker.workerId} (${payload.length.toLocaleString()} chars) to clipboard`))
			.catch((error) => setStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, 4000));
	};

	const renderDetailPane = (width: number, rows: number): string[] => {
		const worker = currentWorker();
		const focusMark = state.paneFocus === "detail" ? "▶" : " ";
		if (!worker) {
			return enforceWidth([
				`${focusMark} Inspector`,
				"No worker selected.",
			], width);
		}

		const bodyText = state.detailTab === "overview"
			? buildOverviewText(worker)
			: state.detailTab === "deliverable"
				? buildDeliverableText(worker, teamManager.getWorkerTranscript(worker.workerId))
				: buildConsoleText(worker, teamManager.getWorkerConsole(worker.workerId));
		const wrappedBody = wrapLines(bodyText, width);
		const tabLabel = state.detailTab === "overview"
			? "[Overview] Deliverable Console"
			: state.detailTab === "deliverable"
				? "Overview [Deliverable] Console"
				: "Overview Deliverable [Console]";
		const headerLines = [
			`${focusMark} Inspector · ${worker.workerId} · ${worker.profileName}:${worker.status}`,
			`${tabLabel} · tab/shift+tab cycle · o/d/c jump tabs`,
		];
		const pageHeight = Math.max(MIN_DETAIL_ROWS, rows - headerLines.length - 1);
		const maxTop = Math.max(0, wrappedBody.length - pageHeight);
		const top = Math.min(state.detailScrollTop, maxTop);
		state.detailScrollTop = top;
		lastRenderMetrics.detailPageSize = pageHeight;
		const visibleBody = wrappedBody.slice(top, top + pageHeight);
		const metaLine = `Scroll ${wrappedBody.length === 0 ? 0 : top + 1}-${Math.min(wrappedBody.length, top + visibleBody.length)} / ${wrappedBody.length}`;
		return enforceWidth([...headerLines, metaLine, ...visibleBody], width).slice(0, rows);
	};

	const renderListPane = (width: number, rows: number): string[] => {
		const focusMark = state.paneFocus === "list" ? "▶" : " ";
		const lines = [
			`${focusMark} Queue · ${Object.keys(snapshot.activeWorkers).length} tracked`,
			buildActionSummaryLine(snapshot),
		];
		for (const section of buildRosterSections(snapshot)) {
			if (section.workers.length === 0) continue;
			lines.push(`${section.label} (${section.workers.length})`);
			for (const worker of section.workers) {
				lines.push(buildRosterRow(worker, worker.workerId === state.selectedWorkerId, width));
			}
			lines.push("");
		}
		if (Object.keys(snapshot.activeWorkers).length === 0) {
			lines.push("No tracked workers.");
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		lastRenderMetrics.listPageSize = Math.max(1, Math.min(rows - 2, getAttentionOrderedWorkerIds(snapshot).length || 1));
		return enforceWidth(lines, width).slice(0, rows);
	};

	ensureSelectedWorker();

	return {
		render(width: number): string[] {
			refreshSnapshot();
			const layout = computeLayoutMode(width);
			lastRenderMetrics.layout = layout;
			const overlayRows = computeOverlayRows(tui.terminal.rows);
			const status = activeStatus();
			const selectedSummary = currentWorker() ? buildWorkerPrioritySnippet(currentWorker()!) : "no worker selected";
			const baseHeader = [
				"Pi Agents Team · /team",
				`${buildActionSummaryLine(snapshot)} · selected=${state.selectedWorkerId ?? "none"}`,
				layout === "split"
					? `[←/→ focus · ↑/↓ move or scroll · tab cycle tabs · enter inspect · y copy · r refresh · esc back · q quit]`
					: state.narrowView === "list"
						? `[↑/↓ move · enter inspect · tab open/cycle tabs · y copy · r refresh · esc close · q quit]`
						: `[j/k·↑↓ scroll · PgUp/PgDn page · g/G top/bottom · tab cycle tabs · o/d/c tabs · y copy · r refresh · esc back · q quit]`,
				`Focus: ${state.paneFocus} · ${selectedSummary}`,
				...(status ? [`» ${status}`] : []),
				"",
			];
			const bodyRows = Math.max(8, overlayRows - baseHeader.length);

			if (layout === "split") {
				const listWidth = clamp(Math.floor(width * 0.38), 30, Math.max(30, width - 36));
				const separator = " │ ";
				const detailWidth = Math.max(24, width - listWidth - visibleWidth(separator));
				const listLines = renderListPane(listWidth, bodyRows);
				const detailLines = renderDetailPane(detailWidth, bodyRows);
				const rowCount = Math.max(listLines.length, detailLines.length, bodyRows);
				const combined: string[] = [];
				for (let index = 0; index < rowCount; index += 1) {
					combined.push(`${padToWidth(listLines[index] ?? "", listWidth)}${separator}${padToWidth(detailLines[index] ?? "", detailWidth)}`);
				}
				return enforceWidth([...baseHeader, ...combined], width);
			}

			if (state.narrowView === "list") {
				return enforceWidth([...baseHeader, ...renderListPane(width, bodyRows)], width);
			}
			return enforceWidth([...baseHeader, ...renderDetailPane(width, bodyRows)], width);
		},
		invalidate() {},
		handleInput(data: string) {
			const layout = lastRenderMetrics.layout;
			const inList = layout === "split" ? state.paneFocus === "list" : state.narrowView === "list";
			const hasWorker = currentWorker() !== undefined;

			if (matchesKey(data, "tab")) {
				if (layout === "stack" && state.narrowView === "list" && hasWorker) {
					state.narrowView = "detail";
					state.paneFocus = "detail";
					return;
				}
				if (hasWorker) {
					state.detailTab = cycleTab(state.detailTab, 1);
					state.paneFocus = "detail";
					if (layout === "stack") state.narrowView = "detail";
					state.detailScrollTop = 0;
				}
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				if (hasWorker) {
					state.detailTab = cycleTab(state.detailTab, -1);
					state.paneFocus = "detail";
					if (layout === "stack") state.narrowView = "detail";
					state.detailScrollTop = 0;
				}
				return;
			}
			if (data === "q") {
				done();
				return;
			}
			if (data === "r") {
				refreshActive();
				return;
			}
			if (data === "y") {
				copyCurrentDetail();
				return;
			}
			if (layout === "split" && (data === "h" || matchesKey(data, "left"))) {
				state.paneFocus = "list";
				return;
			}
			if (layout === "split" && (data === "l" || matchesKey(data, "right"))) {
				if (hasWorker) state.paneFocus = "detail";
				return;
			}
			if (matchesKey(data, "escape")) {
				if (layout === "split") {
					if (state.paneFocus === "detail") {
						state.paneFocus = "list";
						return;
					}
					done();
					return;
				}
				if (state.narrowView === "detail") {
					state.narrowView = "list";
					state.paneFocus = "list";
					return;
				}
				done();
				return;
			}

			if (inList) {
				if (matchesKey(data, "enter")) {
					if (hasWorker) {
						state.paneFocus = "detail";
						state.narrowView = "detail";
						state.detailScrollTop = 0;
					}
					return;
				}
				if (data === "j" || matchesKey(data, "down")) {
					moveListSelection(1);
					return;
				}
				if (data === "k" || matchesKey(data, "up")) {
					moveListSelection(-1);
					return;
				}
				if (matchesKey(data, "pageDown")) {
					moveListSelection(lastRenderMetrics.listPageSize);
					return;
				}
				if (matchesKey(data, "pageUp")) {
					moveListSelection(-lastRenderMetrics.listPageSize);
					return;
				}
				if (data === "g" || matchesKey(data, "home")) {
					jumpListSelection("first");
					return;
				}
				if (data === "G" || matchesKey(data, "end")) {
					jumpListSelection("last");
					return;
				}
				return;
			}

			if (data === "o") {
				state.detailTab = "overview";
				state.detailScrollTop = 0;
				return;
			}
			if (data === "d") {
				state.detailTab = "deliverable";
				state.detailScrollTop = 0;
				return;
			}
			if (data === "c") {
				state.detailTab = "console";
				state.detailScrollTop = 0;
				return;
			}
			if (data === "j" || matchesKey(data, "down")) {
				state.detailScrollTop += 1;
				return;
			}
			if (data === "k" || matchesKey(data, "up")) {
				state.detailScrollTop = Math.max(0, state.detailScrollTop - 1);
				return;
			}
			if (matchesKey(data, "pageDown")) {
				state.detailScrollTop += lastRenderMetrics.detailPageSize;
				return;
			}
			if (matchesKey(data, "pageUp")) {
				state.detailScrollTop = Math.max(0, state.detailScrollTop - lastRenderMetrics.detailPageSize);
				return;
			}
			if (data === "g" || matchesKey(data, "home")) {
				state.detailScrollTop = 0;
				return;
			}
			if (data === "G" || matchesKey(data, "end")) {
				state.detailScrollTop = Number.MAX_SAFE_INTEGER;
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
		(tui, _theme, _keybindings, done) => createTeamDashboardOverlayComponent(tui as TUI, teamManager, state, done, { initialWorkerId: focusWorkerId }),
		{
			overlay: true,
			overlayOptions: TEAM_DASHBOARD_OVERLAY_OPTIONS,
		},
	);
}

export { buildTeamDashboardText };
