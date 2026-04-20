import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SelectList, type SelectItem, matchesKey } from "@mariozechner/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import type { WorkerConsoleEvent } from "../runtime/worker-manager";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types";
import { buildTeamDashboardText } from "./dashboard";

type DetailTab = "summary" | "console";

type View =
	| { kind: "list" }
	| { kind: "detail"; workerId: string; tab: DetailTab; scrollTop: number };

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
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.length <= width) {
			out.push(raw);
			continue;
		}
		let remaining = raw;
		while (remaining.length > width) {
			out.push(remaining.slice(0, width));
			remaining = remaining.slice(width);
		}
		if (remaining.length > 0) out.push(remaining);
	}
	return out;
}

export interface OpenTeamDashboardOptions {
	initialWorkerId?: string;
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
		(_tui, _theme, _keybindings, done) => {
			let view: View = focusWorkerId
				? { kind: "detail", workerId: focusWorkerId, tab: "summary", scrollTop: 0 }
				: { kind: "list" };
			let snapshot = state;
			const maxVisible = 12;

			const theme = {
				selectedPrefix: (t: string) => `› ${t}`,
				selectedText: (t: string) => t,
				description: (t: string) => t,
				scrollInfo: (t: string) => t,
				noMatch: (t: string) => t,
			};

			let selectList = new SelectList(buildWorkerItems(snapshot), maxVisible, theme);

			const rebuildList = () => {
				snapshot = teamManager.snapshot();
				selectList = new SelectList(buildWorkerItems(snapshot), maxVisible, theme);
			};

			const refreshSnapshot = () => {
				snapshot = teamManager.snapshot();
			};

			const refreshActive = () => {
				teamManager.pingWorkers({ mode: "active" })
					.then(() => {
						snapshot = teamManager.snapshot();
					})
					.catch(() => {});
			};

			const component = {
				render(width: number): string[] {
					if (view.kind === "list") {
						const header = [
							"Pi Agent Team · workers",
							`mode=${snapshot.sessionMode} · active=${Object.keys(snapshot.activeWorkers).length} · relays=${snapshot.relayQueue.length}`,
							"",
						];
						const listLines = selectList.render(width);
						const footer = ["", "[↑/↓ navigate · enter open · r refresh · esc close]"];
						return [...header, ...listLines, ...footer];
					}

					const worker = snapshot.activeWorkers[view.workerId];
					if (!worker) {
						return [
							`Worker ${view.workerId} is no longer tracked.`,
							"",
							"[esc back]",
						];
					}

					const tabs = view.tab === "summary"
						? "[Summary] (c) Console"
						: "(s) Summary [Console]";
					const footerLine = "[j/k or ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · s/c switch tab · r refresh · esc back · q quit]";

					const bodyText = view.tab === "summary"
						? buildSummaryText(worker, teamManager.getWorkerTranscript(worker.workerId))
						: buildConsoleText(worker, teamManager.getWorkerConsole(worker.workerId));

					const headerLines = [tabs, ""];
					const wrappedBody = wrapLines(bodyText, width);
					const pageHeight = Math.max(6, 22 - headerLines.length - 1);
					const maxTop = Math.max(0, wrappedBody.length - pageHeight);
					const top = Math.min(view.scrollTop, maxTop);
					view = { ...view, scrollTop: top };
					const visibleBody = wrappedBody.slice(top, top + pageHeight);
					return [...headerLines, ...visibleBody, "", footerLine];
				},
				invalidate() {
					selectList.invalidate();
				},
				handleInput(data: string) {
					if (view.kind === "list") {
						if (matchesKey(data, "escape") || data === "q") {
							done();
							return;
						}
						if (data === "r") {
							refreshActive();
							rebuildList();
							return;
						}
						if (matchesKey(data, "enter")) {
							const item = selectList.getSelectedItem();
							if (item && item.value !== "__none__") {
								view = { kind: "detail", workerId: item.value, tab: "summary", scrollTop: 0 };
							}
							return;
						}
						selectList.handleInput(data);
						return;
					}

					if (matchesKey(data, "escape")) {
						view = { kind: "list" };
						rebuildList();
						return;
					}
					if (data === "q") {
						done();
						return;
					}
					if (data === "s") {
						view = { ...view, tab: "summary", scrollTop: 0 };
						return;
					}
					if (data === "c") {
						view = { ...view, tab: "console", scrollTop: 0 };
						return;
					}
					if (data === "r") {
						refreshSnapshot();
						return;
					}
					if (data === "j" || matchesKey(data, "down")) {
						view = { ...view, scrollTop: view.scrollTop + 1 };
						return;
					}
					if (data === "k" || matchesKey(data, "up")) {
						view = { ...view, scrollTop: Math.max(0, view.scrollTop - 1) };
						return;
					}
					if (matchesKey(data, "pageDown")) {
						view = { ...view, scrollTop: view.scrollTop + 10 };
						return;
					}
					if (matchesKey(data, "pageUp")) {
						view = { ...view, scrollTop: Math.max(0, view.scrollTop - 10) };
						return;
					}
					if (data === "g") {
						view = { ...view, scrollTop: 0 };
						return;
					}
					if (data === "G") {
						view = { ...view, scrollTop: Number.MAX_SAFE_INTEGER };
						return;
					}
				},
			};

			return component;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "right-center", width: "70%", maxHeight: "85%", margin: 1 },
		},
	);
}

export { buildTeamDashboardText };
