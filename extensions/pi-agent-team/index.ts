import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TEAM_CONFIG, createDefaultTeamState, renderTeamStatusText } from "../../src/config";
import {
	createPersistedStateSnapshot,
	markRestoredWorkersExited,
	restorePersistedTeamState,
} from "../../src/control-plane/persistence";
import { buildOrchestratorPromptBundle } from "../../src/prompts/contracts";
import { TeamManager } from "../../src/control-plane/team-manager";
import { registerAgentCommands } from "../../src/commands/agents";
import { registerCancelCommand } from "../../src/commands/cancel";
import { registerWorkerMessageCommands } from "../../src/commands/steer";
import { registerTeamCommand } from "../../src/commands/team";
import { buildTeamStatusLine, buildTeamWidgetLines } from "../../src/ui/status-widget";
import type { PersistedTeamState, WorkerRuntimeState } from "../../src/types";

const DelegateTaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the delegated task" }),
	goal: Type.String({ description: "What the worker should accomplish" }),
	profileName: Type.String({ description: "Worker profile name such as explorer, fixer, or reviewer" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Defaults to the current session cwd." })),
	contextHints: Type.Optional(Type.Array(Type.String(), { description: "Compact context bullets to pass into the worker" })),
	expectedOutput: Type.Optional(Type.String({ description: "Describe the output contract the worker should return" })),
	pathScopeRoots: Type.Optional(Type.Array(Type.String(), { description: "Allowed path roots for scoped workers, especially write-capable profiles." })),
	pathScopeAllowWrite: Type.Optional(Type.Boolean({ description: "Whether the delegated path scope may be written to." })),
	model: Type.Optional(Type.String({ description: "Override the worker model (e.g. \"provider/model-id\"). Defaults to the orchestrator's current model." })),
});

const WorkerLookupSchema = Type.Object({
	workerId: Type.Optional(Type.String({ description: "Specific worker id. Omit to inspect all tracked workers." })),
});

const WorkerMessageSchema = Type.Object({
	workerId: Type.String({ description: "Target worker id" }),
	message: Type.String({ description: "Instruction for the worker" }),
	delivery: Type.Optional(Type.String({ description: 'Delivery mode: "auto", "steer", or "follow_up".' })),
});

const PingAgentsSchema = Type.Object({
	workerIds: Type.Optional(Type.Array(Type.String(), { description: "Worker ids to ping. Omit to ping all workers." })),
	mode: Type.Optional(Type.String({ description: 'Ping mode: "passive" or "active". Active mode refreshes state and stats.' })),
});

const WorkerIdSchema = Type.Object({
	workerId: Type.String({ description: "Target worker id" }),
});

function restoreLatestState(ctx: ExtensionContext): PersistedTeamState {
	const restoredState = restorePersistedTeamState(
		ctx.sessionManager.getEntries(),
		DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
	);
	return markRestoredWorkersExited(restoredState);
}

function applyUi(ctx: ExtensionContext | undefined, state: PersistedTeamState): void {
	if (!ctx?.hasUI) return;

	ctx.ui.setStatus(DEFAULT_TEAM_CONFIG.ui.statusKey, buildTeamStatusLine(state));
	ctx.ui.setWidget(DEFAULT_TEAM_CONFIG.ui.widgetKey, buildTeamWidgetLines(state));
	ctx.ui.setTitle(DEFAULT_TEAM_CONFIG.ui.titleTemplate.replace("{mode}", state.sessionMode));
}

function clearUi(ctx: ExtensionContext | undefined): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(DEFAULT_TEAM_CONFIG.ui.statusKey, undefined);
	ctx.ui.setWidget(DEFAULT_TEAM_CONFIG.ui.widgetKey, undefined);
}

function persistSnapshot(pi: ExtensionAPI, state: PersistedTeamState): void {
	pi.appendEntry(DEFAULT_TEAM_CONFIG.persistence.stateCustomType, createPersistedStateSnapshot(state));
}

function formatWorker(worker: WorkerRuntimeState): string {
	const parts = [`${worker.workerId} (${worker.profileName})`, `status=${worker.status}`];
	if (worker.currentTask?.title) parts.push(`task=${worker.currentTask.title}`);
	if (worker.lastSummary?.headline) parts.push(`summary=${worker.lastSummary.headline}`);
	if (worker.pendingRelayQuestions.length > 0) parts.push(`relays=${worker.pendingRelayQuestions.length}`);
	return parts.join(" · ");
}

function formatWorkers(workers: WorkerRuntimeState[]): string {
	if (workers.length === 0) return "No active or persisted workers.";
	return workers.map((worker) => `- ${formatWorker(worker)}`).join("\n");
}

function emitCommandOutput(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
	if (ctx.hasUI) {
		pi.sendMessage({
			customType: DEFAULT_TEAM_CONFIG.persistence.statusMessageType,
			content: text,
			display: true,
		});
		return;
	}

	console.log(text);
}

export default function (pi: ExtensionAPI): void {
	const teamManager = new TeamManager({ config: DEFAULT_TEAM_CONFIG });
	let teamState = createDefaultTeamState(DEFAULT_TEAM_CONFIG);
	let activeContext: ExtensionContext | undefined;

	teamManager.onStateChange((state) => {
		teamState = state;
		persistSnapshot(pi, teamState);
		applyUi(activeContext, teamState);
	});

	const commandDependencies = {
		teamManager,
		emitText: (ctx: ExtensionContext, text: string) => emitCommandOutput(pi, ctx, text),
	};
	registerTeamCommand(pi, commandDependencies);
	registerAgentCommands(pi, commandDependencies);
	registerWorkerMessageCommands(pi, commandDependencies);
	registerCancelCommand(pi, commandDependencies);

	pi.registerCommand("team-status", {
		description: "Show the Pi Agent Team scaffold status and tracked workers",
		handler: async (_args, ctx) => {
			teamState = teamManager.snapshot();
			emitCommandOutput(pi, ctx, `${renderTeamStatusText(teamState, DEFAULT_TEAM_CONFIG)}\n${formatWorkers(teamManager.listWorkers())}`);
		},
	});

	pi.registerCommand("agent-result", {
		description: "Show the latest compact result for a worker: /agent-result <worker-id>",
		handler: async (args, ctx) => {
			const workerId = args.trim();
			if (!workerId) {
				ctx.ui.notify("Usage: /agent-result <worker-id>", "warning");
				return;
			}
			const result = teamManager.getWorkerResult(workerId);
			if (!result) {
				ctx.ui.notify(`Unknown worker: ${workerId}`, "warning");
				return;
			}
			emitCommandOutput(pi, ctx, formatWorker(result.worker));
		},
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Launch a background Pi RPC worker for a bounded delegated task and track it in the orchestrator state.",
		parameters: DelegateTaskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const pathScope = params.pathScopeRoots?.length
				? {
					roots: params.pathScopeRoots,
					allowReadOutsideRoots: false,
					allowWrite: params.pathScopeAllowWrite === true,
				}
				: undefined;
			const orchestratorModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const result = await teamManager.delegateTask({
				title: params.title,
				goal: params.goal,
				profileName: params.profileName,
				cwd: params.cwd ?? ctx.cwd,
				contextHints: params.contextHints,
				expectedOutput: params.expectedOutput,
				pathScope,
				model: params.model ?? orchestratorModel,
			});
			teamState = teamManager.snapshot();
			applyUi(activeContext, teamState);
			return {
				content: [
					{
						type: "text",
						text: `Delegated ${result.task?.title ?? params.title} to ${result.worker.profileName} as ${result.worker.workerId}.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Return compact status for one worker or all tracked workers.",
		parameters: WorkerLookupSchema,
		async execute(_toolCallId, params) {
			const workers = params.workerId
				? [teamManager.getWorkerStatus(params.workerId)].filter((worker): worker is WorkerRuntimeState => Boolean(worker))
				: teamManager.listWorkers();
			return {
				content: [{ type: "text", text: formatWorkers(workers) }],
				details: { workers },
			};
		},
	});

	pi.registerTool({
		name: "agent_result",
		label: "Agent Result",
		description: "Get the latest compact result for a tracked worker.",
		parameters: WorkerIdSchema,
		async execute(_toolCallId, params) {
			const result = teamManager.getWorkerResult(params.workerId);
			if (!result) {
				throw new Error(`Unknown worker: ${params.workerId}`);
			}
			return {
				content: [{ type: "text", text: formatWorker(result.worker) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "agent_message",
		label: "Agent Message",
		description: "Send a steer or follow-up message to a tracked worker.",
		parameters: WorkerMessageSchema,
		async execute(_toolCallId, params) {
			const delivery = params.delivery === "steer" || params.delivery === "follow_up" ? params.delivery : "auto";
			const result = await teamManager.messageWorker(params.workerId, params.message, delivery);
			return {
				content: [{ type: "text", text: `Sent message to ${result.worker.workerId}.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ping_agents",
		label: "Ping Agents",
		description: "Return passive or active status for tracked workers.",
		parameters: PingAgentsSchema,
		async execute(_toolCallId, params) {
			const mode = params.mode === "active" ? "active" : "passive";
			const results = await teamManager.pingWorkers({ workerIds: params.workerIds, mode });
			return {
				content: [{ type: "text", text: formatWorkers(results.map((result) => result.worker)) }],
				details: { mode, results },
			};
		},
	});

	pi.registerTool({
		name: "agent_cancel",
		label: "Agent Cancel",
		description: "Abort and shut down a tracked worker.",
		parameters: WorkerIdSchema,
		async execute(_toolCallId, params) {
			const result = await teamManager.cancelWorker(params.workerId);
			return {
				content: [{ type: "text", text: `Cancelled ${result.worker.workerId}.` }],
				details: result,
			};
		},
	});

	pi.on("session_start", async (event, ctx) => {
		activeContext = ctx;
		teamState = restoreLatestState(ctx);
		teamManager.restore(teamState);
		applyUi(ctx, teamState);
		persistSnapshot(pi, teamState);

		if (ctx.hasUI && event.reason === "startup") {
			ctx.ui.notify("Pi Agent Team loaded: this session is running in orchestrator mode.", "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeContext = ctx;
		teamState = teamManager.snapshot();
		applyUi(ctx, teamState);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildOrchestratorPromptBundle(teamState, DEFAULT_TEAM_CONFIG)}`,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await teamManager.dispose();
		teamState = teamManager.snapshot();
		persistSnapshot(pi, teamState);
		clearUi(ctx);
		activeContext = undefined;
	});
}
