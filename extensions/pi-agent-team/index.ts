import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_TEAM_CONFIG,
	buildDashboardEntries,
	buildOrchestratorSystemPrompt,
	buildTeamWidgetLines,
	createDefaultTeamState,
	normalizePersistedTeamState,
	renderTeamStatusText,
} from "../../src/config";
import type { PersistedTeamState } from "../../src/types";

function restoreLatestState(ctx: ExtensionContext): { state: PersistedTeamState; foundPersistedState: boolean } {
	let latestState: PersistedTeamState | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== DEFAULT_TEAM_CONFIG.persistence.stateCustomType) continue;
		latestState = normalizePersistedTeamState(entry.data, DEFAULT_TEAM_CONFIG);
	}

	return latestState
		? { state: latestState, foundPersistedState: true }
		: { state: createDefaultTeamState(DEFAULT_TEAM_CONFIG), foundPersistedState: false };
}

function syncDerivedState(state: PersistedTeamState): PersistedTeamState {
	const dashboardEntries = buildDashboardEntries(state.activeWorkers);
	return {
		...state,
		ui: {
			...state.ui,
			dashboardEntries,
			lastRenderAt: Date.now(),
		},
		updatedAt: Date.now(),
	};
}

function persistStateSnapshot(pi: ExtensionAPI, state: PersistedTeamState): void {
	pi.appendEntry(DEFAULT_TEAM_CONFIG.persistence.stateCustomType, syncDerivedState(state));
}

function applyUi(ctx: ExtensionContext, state: PersistedTeamState): void {
	if (!ctx.hasUI) return;

	const workerCount = Object.keys(state.activeWorkers).length;
	const workerLabel = workerCount === 1 ? "worker" : "workers";
	ctx.ui.setStatus(DEFAULT_TEAM_CONFIG.ui.statusKey, `${state.sessionMode} · ${workerCount} ${workerLabel}`);
	ctx.ui.setWidget(DEFAULT_TEAM_CONFIG.ui.widgetKey, buildTeamWidgetLines(state, DEFAULT_TEAM_CONFIG));
	ctx.ui.setTitle(DEFAULT_TEAM_CONFIG.ui.titleTemplate.replace("{mode}", state.sessionMode));
}

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(DEFAULT_TEAM_CONFIG.ui.statusKey, undefined);
	ctx.ui.setWidget(DEFAULT_TEAM_CONFIG.ui.widgetKey, undefined);
}

export default function (pi: ExtensionAPI) {
	let teamState = createDefaultTeamState(DEFAULT_TEAM_CONFIG);

	pi.registerCommand("team-status", {
		description: "Show the Pi Agent Team scaffold status and orchestrator contract",
		handler: async (_args, ctx) => {
			teamState = syncDerivedState(teamState);
			const text = renderTeamStatusText(teamState, DEFAULT_TEAM_CONFIG);
			if (ctx.hasUI) {
				pi.sendMessage({
					customType: DEFAULT_TEAM_CONFIG.persistence.statusMessageType,
					content: text,
					display: true,
					details: {
						activeWorkers: Object.keys(teamState.activeWorkers).length,
						sessionMode: teamState.sessionMode,
					},
				});
			} else {
				console.log(text);
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const restored = restoreLatestState(ctx);
		teamState = syncDerivedState(restored.state);
		applyUi(ctx, teamState);

		if (!restored.foundPersistedState) {
			persistStateSnapshot(pi, teamState);
		}

		if (ctx.hasUI && event.reason === "startup") {
			ctx.ui.notify("Pi Agent Team scaffold loaded: this session now defaults to orchestrator mode.", "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		teamState = syncDerivedState(teamState);
		applyUi(ctx, teamState);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildOrchestratorSystemPrompt(teamState, DEFAULT_TEAM_CONFIG)}`,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		teamState = syncDerivedState(teamState);
		persistStateSnapshot(pi, teamState);
		clearUi(ctx);
	});
}
