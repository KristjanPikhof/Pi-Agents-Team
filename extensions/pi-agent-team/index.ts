import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TEAM_CONFIG, createDefaultTeamState, renderTeamStatusText } from "../../src/config";
import {
	createPersistedStateSnapshot,
	markRestoredWorkersExited,
	restorePersistedTeamState,
} from "../../src/control-plane/persistence";
import { buildOrchestratorPromptBundle } from "../../src/prompts/contracts";
import { TeamManager, isTerminalWorkerStatus } from "../../src/control-plane/team-manager";
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

const WaitForAgentsSchema = Type.Object({
	workerIds: Type.Optional(Type.Array(Type.String(), { description: "Worker ids to wait on. Omit to wait on every tracked worker." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds. Defaults to 300000 (5 min)." })),
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
	if (worker.lastToolName && worker.status === "running") parts.push(`tool=${worker.lastToolName}`);
	if (worker.lastSummary?.headline) {
		const tag = worker.status === "running" ? "interim" : "summary";
		parts.push(`${tag}=${worker.lastSummary.headline}`);
	}
	if (worker.pendingRelayQuestions.length > 0) parts.push(`relays=${worker.pendingRelayQuestions.length}`);
	return parts.join(" · ");
}

function formatWorkers(workers: WorkerRuntimeState[]): string {
	if (workers.length === 0) return "No active or persisted workers.";
	return workers.map((worker) => `- ${formatWorker(worker)}`).join("\n");
}

function truncateList(items: string[], max: number): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}… (+${items.length - max} more)`;
}

function formatWorkerCompact(worker: WorkerRuntimeState): string {
	const lines = [
		`Worker: ${worker.workerId} (${worker.profileName})`,
		`Status: ${worker.status}`,
	];
	if (worker.currentTask?.title) lines.push(`Task: ${worker.currentTask.title}`);
	if (worker.error) lines.push(`Error: ${worker.error}`);

	const summary = worker.lastSummary;
	if (summary) {
		if (summary.headline) lines.push(`Headline: ${summary.headline}`);
		if (summary.readFiles.length) lines.push(`Read files: ${truncateList(summary.readFiles, 10)}`);
		if (summary.changedFiles.length) lines.push(`Changed files: ${truncateList(summary.changedFiles, 10)}`);
		if (summary.risks.length) lines.push(`Risks: ${truncateList(summary.risks, 5)}`);
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
		`Usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens} cost=$${worker.usage.costUsd.toFixed(4)}`,
		`Full transcript available via /team overlay → select ${worker.workerId} → Enter, or /agent-result ${worker.workerId} in the terminal. Do NOT request it unless the user explicitly asks.`,
	);

	return lines.join("\n");
}

function formatWorkerDetail(worker: WorkerRuntimeState, transcript?: string): string {
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
		lines.push("", "No assistant text captured yet (worker has not emitted a final message).");
	}

	return lines.join("\n");
}

function workerIdCompletions(teamManager: TeamManager, prefix: string) {
	return teamManager
		.listWorkers()
		.filter((worker) => worker.workerId.startsWith(prefix))
		.map((worker) => ({
			value: worker.workerId,
			label: worker.workerId,
			description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
		}));
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
	const lastStatus = new Map<string, WorkerRuntimeState["status"]>();
	const lastRelayCount = new Map<string, number>();
	const pendingTerminalTransitions: Array<{ workerId: string; profileName: string; status: WorkerRuntimeState["status"] }> = [];
	let notificationTimer: NodeJS.Timeout | undefined;

	function flushTerminalNotifications(): void {
		notificationTimer = undefined;
		if (pendingTerminalTransitions.length === 0) return;
		const items = pendingTerminalTransitions.splice(0);
		if (!activeContext?.hasUI) return;
		const message = items.length === 1
			? `✓ ${items[0].workerId} (${items[0].profileName}) finished — status=${items[0].status}`
			: `✓ ${items.length} workers finished — ${items.map((i) => i.workerId).join(", ")}`;
		activeContext.ui.notify(message, "info");
	}

	teamManager.onStateChange((state) => {
		teamState = state;
		persistSnapshot(pi, teamState);
		applyUi(activeContext, teamState);

		for (const worker of Object.values(state.activeWorkers)) {
			const previous = lastStatus.get(worker.workerId);
			const nowTerminal = isTerminalWorkerStatus(worker.status);
			const wasTerminal = previous ? isTerminalWorkerStatus(previous) : false;
			if (previous !== worker.status && nowTerminal && !wasTerminal) {
				pendingTerminalTransitions.push({
					workerId: worker.workerId,
					profileName: worker.profileName,
					status: worker.status,
				});
				if (notificationTimer) clearTimeout(notificationTimer);
				notificationTimer = setTimeout(flushTerminalNotifications, 400);
			}
			lastStatus.set(worker.workerId, worker.status);

			const prevRelays = lastRelayCount.get(worker.workerId) ?? 0;
			const currRelays = worker.pendingRelayQuestions.length;
			if (currRelays > prevRelays && activeContext?.hasUI) {
				const newest = worker.pendingRelayQuestions[worker.pendingRelayQuestions.length - 1];
				const preview = newest?.question ? newest.question.replace(/\s+/g, " ").slice(0, 120) : "needs guidance";
				activeContext.ui.notify(`❓ ${worker.workerId} (${worker.profileName}) needs guidance: ${preview}`, "warning");
			}
			lastRelayCount.set(worker.workerId, currRelays);
		}
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
		description: "Show the full result for a worker: /agent-result <worker-id>",
		getArgumentCompletions: (prefix) => workerIdCompletions(teamManager, prefix),
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /agent-result <worker-id>", "warning");
				return;
			}
			const resolved = teamManager.resolveWorkerId(input);
			if (!resolved) {
				ctx.ui.notify(`Unknown worker: ${input}`, "warning");
				return;
			}
			const result = teamManager.getWorkerResult(resolved);
			if (!result) {
				ctx.ui.notify(`Unknown worker: ${resolved}`, "warning");
				return;
			}
			const transcript = teamManager.getWorkerTranscript(resolved);
			emitCommandOutput(pi, ctx, formatWorkerDetail(result.worker, transcript));
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
		description: "Return compact status (running/idle/exited) for one worker or all tracked workers. Use this to decide if a worker is done. For the worker's actual output, call agent_result.",
		parameters: WorkerLookupSchema,
		async execute(_toolCallId, params) {
			const resolvedId = params.workerId ? teamManager.resolveWorkerId(params.workerId) ?? params.workerId : undefined;
			const workers = resolvedId
				? [teamManager.getWorkerStatus(resolvedId)].filter((worker): worker is WorkerRuntimeState => Boolean(worker))
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
		description: "Get the worker's structured compact summary (headline, files touched, risks, next recommendation, relay questions). This is what you synthesize from. The full raw transcript is NOT returned here — it lives in the /team UI overlay and the /agent-result slash command so it does not pollute the main conversation. Only request the transcript via another channel if the user explicitly asks to see it.",
		parameters: WorkerIdSchema,
		async execute(_toolCallId, params) {
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = teamManager.getWorkerResult(workerId);
			if (!result) {
				throw new Error(`Unknown worker: ${params.workerId}`);
			}
			return {
				content: [{ type: "text", text: formatWorkerCompact(result.worker) }],
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
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = await teamManager.messageWorker(workerId, params.message, delivery);
			return {
				content: [{ type: "text", text: `Sent message to ${result.worker.workerId}.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ping_agents",
		label: "Ping Agents",
		description: "Return passive or active status for tracked workers. Poll this while waiting for workers to finish. A worker is done when status is idle/exited/aborted/error; running means not done.",
		parameters: PingAgentsSchema,
		async execute(_toolCallId, params) {
			const mode = params.mode === "active" ? "active" : "passive";
			const resolvedIds = params.workerIds?.map((id) => teamManager.resolveWorkerId(id) ?? id);
			const results = await teamManager.pingWorkers({ workerIds: resolvedIds, mode });
			return {
				content: [{ type: "text", text: formatWorkers(results.map((result) => result.worker)) }],
				details: { mode, results },
			};
		},
	});

	pi.registerTool({
		name: "wait_for_agents",
		label: "Wait for Agents",
		description: "Block until the specified workers all reach a terminal status (idle, exited, aborted, error), or until the timeout elapses. Prefer this over repeated ping_agents polling — it consumes no tokens while waiting and returns exactly once when workers are done. Use it after delegate_task.",
		parameters: WaitForAgentsSchema,
		async execute(_toolCallId, params, signal) {
			const targetIds = params.workerIds?.length
				? params.workerIds.map((id) => teamManager.resolveWorkerId(id) ?? id)
				: teamManager.listWorkers().map((worker) => worker.workerId);
			type WaitDetails = { reason: "all_terminal" | "timeout" | "aborted" | "no_workers"; workers: WorkerRuntimeState[] };
			if (targetIds.length === 0) {
				const details: WaitDetails = { reason: "no_workers", workers: [] };
				return {
					content: [{ type: "text", text: "No tracked workers to wait on." }],
					details,
				};
			}
			const result = await teamManager.waitForTerminal(targetIds, {
				timeoutMs: params.timeoutMs ?? 300_000,
				signal,
			});
			const header = result.reason === "all_terminal"
				? `All ${result.workers.length} worker(s) reached terminal status.`
				: result.reason === "timeout"
					? `Wait timed out; some workers may still be running.`
					: `Wait aborted.`;
			const details: WaitDetails = { reason: result.reason, workers: result.workers };
			return {
				content: [{ type: "text", text: `${header}\n${formatWorkers(result.workers)}` }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "agent_cancel",
		label: "Agent Cancel",
		description: "Abort and shut down a tracked worker.",
		parameters: WorkerIdSchema,
		async execute(_toolCallId, params) {
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = await teamManager.cancelWorker(workerId);
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
