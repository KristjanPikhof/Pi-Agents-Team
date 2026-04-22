import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SelectList, type SelectItem, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TUI, OverlayOptions } from "@mariozechner/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import type { WorkerConsoleEvent } from "../runtime/worker-manager";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types";
import { copyToClipboard } from "../util/clipboard";
import { buildCopyPayload } from "./copy-payload";
import { buildTeamDashboardText } from "./dashboard";

type DetailTab = "summary" | "console";
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
const MIN_LIST_ROWS = 4;
const MAX_LIST_ROWS = 18;
const MIN_DETAIL_ROWS = 6;

function buildWorkerItems(state: PersistedTeamState): SelectItem[] {
	const workers = Object.values(state.activeWorkers).sort((left, right) => compareWorkerIds(left.workerId, right.workerId));
	if (workers.length === 0) {
		return [{ value: "__none__", label: "no tracked workers", description: "run delegate_task first" }];
	}
	return workers.map((worker) => ({
		value: worker.workerId,
		label: `${worker.workerId} · ${worker.profileName}:${worker.status}`,
		description: worker.lastSummary?.headline ?? worker.currentTask?.title ?? "",
	}));
}

function buildSummaryText(worker: WorkerRuntimeState, transcript: string | undefined): string {
	const lines = [
		`Worker: ${worker.workerId}`,
		`Profile: ${worker.profileName}`,
		`Status: ${worker.status}`,
	];
	if (worker.currentTask?.title) lines.push(`Task: ${worker.currentTask.title}`);
	if (worker.currentTask?.goal) lines.push(`Goal: ${worker.currentTask.goal}`);
	if (worker.lastToolName) lines.push(`Last tool: ${worker.lastToolName}`);
	if (worker.error) lines.push(`Error: ${worker.error}`);

	const summary = worker.lastSummary;
	if (summary) {
		if (summary.headline) lines.push(`Headline: ${summary.headline}`);
		if (summary.readFiles.length) lines.push(`Read files: ${summary.readFiles.join(", ")}`);
		if (summary.changedFiles.length) lines.push(`Changed files: ${summary.changedFiles.join(", ")}`);
		if (summary.risks.length) lines.push(`Risks: ${summary.risks.join("; ")}`);
		if (summary.nextRecommendation) lines.push(`Next: ${summary.nextRecommendation}`);
	}

	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("", "Pending relay questions:");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
			lines.push(`  assumption: ${relay.assumption}`);
		}
	}

	lines.push(
		"",
		`Usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens} cost=$${worker.usage.costUsd.toFixed(4)}`,
	);

	if (transcript && transcript.trim()) {
		lines.push("", "--- Latest assistant text ---", transcript.trim());
	} else {
		lines.push("", "No assistant text captured yet.");
	}

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
	const tabs: DetailTab[] = ["summary", "console"];
	const index = tabs.indexOf(tab);
	return tabs[(index + direction + tabs.length) % tabs.length] ?? tab;
}

function computeOverlayRows(termRows: number): number {
	return Math.max(MIN_OVERLAY_ROWS, Math.min(Math.max(1, termRows - 2), Math.floor(termRows * 0.9)));
}

function computeLayoutMode(termWidth: number): LayoutMode {
	return termWidth >= WIDE_LAYOUT_MIN_WIDTH ? "split" : "stack";
}

function getSelectableWorkerIds(state: PersistedTeamState): string[] {
	return Object.values(state.activeWorkers)
		.sort((left, right) => compareWorkerIds(left.workerId, right.workerId))
		.map((worker) => worker.workerId);
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
		detailTab: "summary",
		detailScrollTop: 0,
	};
	let statusMessage: string | undefined;
	let statusExpires = 0;
	let currentListVisible = 12;
	let lastRenderMetrics: RenderMetrics = { layout: computeLayoutMode(tui.terminal.columns), listPageSize: 11, detailPageSize: 10 };

	const theme = {
		selectedPrefix: (_t: string) => "▶ ",
		selectedText: (text: string) => `▶ ${text.slice(2)}`,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	};

	let selectList = new SelectList(buildWorkerItems(snapshot), currentListVisible, theme);

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

	const syncSelectionFromList = () => {
		const item = selectList.getSelectedItem();
		if (item && item.value !== "__none__") {
			state.selectedWorkerId = item.value;
		}
	};

	const setSelectedWorker = (workerId: string | undefined, resetScroll = false) => {
		state.selectedWorkerId = workerId;
		const items = buildWorkerItems(snapshot);
		const index = workerId ? items.findIndex((item) => item.value === workerId) : -1;
		if (index >= 0) selectList.setSelectedIndex(index);
		if (workerId && resetScroll) state.detailScrollTop = 0;
	};

	const ensureSelectedWorker = () => {
		const selectableWorkerIds = getSelectableWorkerIds(snapshot);
		if (selectableWorkerIds.length === 0) {
			state.selectedWorkerId = undefined;
			state.paneFocus = "list";
			state.narrowView = "list";
			return;
		}
		if (state.selectedWorkerId && snapshot.activeWorkers[state.selectedWorkerId]) {
			setSelectedWorker(state.selectedWorkerId);
			return;
		}
		setSelectedWorker(selectableWorkerIds[0], true);
	};

	const rebuildList = (nextSnapshot = teamManager.snapshot(), nextVisible = currentListVisible) => {
		snapshot = nextSnapshot;
		currentListVisible = nextVisible;
		selectList = new SelectList(buildWorkerItems(snapshot), currentListVisible, theme);
		ensureSelectedWorker();
		syncSelectionFromList();
	};

	const refreshSnapshot = () => {
		rebuildList(teamManager.snapshot(), currentListVisible);
	};

	const currentWorker = (): WorkerRuntimeState | undefined => {
		if (!state.selectedWorkerId) return undefined;
		return snapshot.activeWorkers[state.selectedWorkerId];
	};

	const moveListSelection = (delta: number) => {
		const workerIds = getSelectableWorkerIds(snapshot);
		if (workerIds.length === 0) return;
		const currentIndex = state.selectedWorkerId ? workerIds.indexOf(state.selectedWorkerId) : 0;
		const safeIndex = currentIndex >= 0 ? currentIndex : 0;
		const nextIndex = clamp(safeIndex + delta, 0, workerIds.length - 1);
		setSelectedWorker(workerIds[nextIndex], true);
	};

	const jumpListSelection = (target: "first" | "last") => {
		const workerIds = getSelectableWorkerIds(snapshot);
		if (workerIds.length === 0) return;
		setSelectedWorker(target === "first" ? workerIds[0] : workerIds[workerIds.length - 1], true);
	};

	const refreshActive = () => {
		teamManager.pingWorkers({ mode: "active" })
			.then(() => {
				rebuildList(teamManager.snapshot(), currentListVisible);
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

		const bodyText = state.detailTab === "summary"
			? buildSummaryText(worker, teamManager.getWorkerTranscript(worker.workerId))
			: buildConsoleText(worker, teamManager.getWorkerConsole(worker.workerId));
		const wrappedBody = wrapLines(bodyText, width);
		const tabLabel = state.detailTab === "summary" ? "[Summary] Console" : "Summary [Console]";
		const headerLines = [
			`${focusMark} Inspector · ${worker.workerId} · ${worker.profileName}:${worker.status}`,
			`${tabLabel} · tab/shift+tab cycle · s/c jump tabs`,
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
		const desiredVisible = clamp(rows - 3, MIN_LIST_ROWS, MAX_LIST_ROWS);
		if (desiredVisible !== currentListVisible) rebuildList(snapshot, desiredVisible);
		syncSelectionFromList();
		const focusMark = state.paneFocus === "list" ? "▶" : " ";
		const lines = [
			`${focusMark} Workers · ${Object.keys(snapshot.activeWorkers).length} tracked`,
			`Selected: ${state.selectedWorkerId ?? "none"}`,
			...selectList.render(width),
		];
		lastRenderMetrics.listPageSize = Math.max(1, desiredVisible - 1);
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
			const baseHeader = [
				"Pi Agents Team · responsive dashboard",
				`mode=${snapshot.sessionMode} · active=${Object.keys(snapshot.activeWorkers).length} · relays=${snapshot.relayQueue.length} · selected=${state.selectedWorkerId ?? "none"} · focus=${state.paneFocus}`,
				layout === "split"
					? "[←/→ or h/l focus panes · ↑/↓ move/scroll · PgUp/PgDn page · tab cycle tabs · enter inspect · y copy · r refresh · esc close pane/back · q quit]"
					: state.narrowView === "list"
						? "[↑/↓ move · PgUp/PgDn page · enter inspect · tab open/cycle tabs · y copy · r refresh · esc close · q quit]"
						: "[j/k·↑↓ scroll · PgUp/PgDn page · g/G top/bottom · tab cycle tabs · s/c tabs · y copy · r refresh · esc back · q quit]",
				...(status ? [`» ${status}`] : []),
				"",
			];
			const bodyRows = Math.max(8, overlayRows - baseHeader.length);

			if (layout === "split") {
				const listWidth = clamp(Math.floor(width * 0.34), 28, Math.max(28, width - 36));
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
		invalidate() {
			selectList.invalidate();
		},
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
				selectList.handleInput(data);
				syncSelectionFromList();
				return;
			}

			if (data === "s") {
				state.detailTab = "summary";
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
