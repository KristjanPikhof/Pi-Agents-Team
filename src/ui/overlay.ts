import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SelectList, type SelectItem, matchesKey } from "@mariozechner/pi-tui";
import type { TeamManager } from "../control-plane/team-manager";
import { compareWorkerIds, type PersistedTeamState, type WorkerRuntimeState } from "../types";
import { buildTeamDashboardText } from "./dashboard";

type View =
	| { kind: "list" }
	| { kind: "detail"; workerId: string; scrollTop: number };

function buildWorkerItems(state: PersistedTeamState): SelectItem[] {
	const workers = Object.values(state.activeWorkers).sort((left, right) => right.lastEventAt - left.lastEventAt);
	if (workers.length === 0) {
		return [{ value: "__none__", label: "no tracked workers", description: "run delegate_task first" }];
	}
	return workers.map((worker) => ({
		value: worker.workerId,
		label: `${worker.workerId} · ${worker.profileName}:${worker.status}`,
		description: worker.lastSummary?.headline ?? worker.currentTask?.title ?? "",
	}));
}

function buildDetailText(worker: WorkerRuntimeState, transcript: string | undefined): string {
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

	lines.push("", "[j/k or ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · esc back · q quit]");
	return lines.join("\n");
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

export async function openTeamDashboardOverlay(ctx: ExtensionContext, teamManager: TeamManager): Promise<void> {
	const state = teamManager.snapshot();

	if (!ctx.hasUI) {
		console.log(buildTeamDashboardText(state));
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => {
			let view: View = { kind: "list" };
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
					const transcript = teamManager.getWorkerTranscript(worker.workerId);
					const text = buildDetailText(worker, transcript);
					const wrapped = wrapLines(text, width);
					const pageHeight = 20;
					const maxTop = Math.max(0, wrapped.length - pageHeight);
					const top = Math.min(view.scrollTop, maxTop);
					view = { ...view, scrollTop: top };
					return wrapped.slice(top, top + pageHeight);
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
							rebuildList();
							return;
						}
						if (matchesKey(data, "enter")) {
							const item = selectList.getSelectedItem();
							if (item && item.value !== "__none__") {
								view = { kind: "detail", workerId: item.value, scrollTop: 0 };
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
					if (data === "r") {
						snapshot = teamManager.snapshot();
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
