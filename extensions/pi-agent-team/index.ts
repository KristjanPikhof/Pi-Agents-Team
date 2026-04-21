import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TEAM_CONFIG, createDefaultTeamState } from "../../src/config";
import {
	createPersistedStateSnapshot,
	markRestoredWorkersExited,
	restorePersistedTeamState,
} from "../../src/control-plane/persistence";
import { buildOrchestratorPromptBundle } from "../../src/prompts/contracts";
import { TeamManager, isTerminalWorkerStatus } from "../../src/control-plane/team-manager";
import { loadActiveTeamConfig } from "../../src/project-config/loader";
import { registerCancelCommand } from "../../src/commands/cancel";
import { registerCopyCommand } from "../../src/commands/copy";
import { registerCostCommand } from "../../src/commands/cost";
import { registerPruneCommand } from "../../src/commands/prune";
import { registerWorkerMessageCommands } from "../../src/commands/steer";
import { registerTeamCommand } from "../../src/commands/team";
import { registerTeamInitCommand } from "../../src/commands/team-init";
import { registerTeamToggleCommands } from "../../src/commands/team-toggle";
import { formatUnknownWorker, suggestTargets } from "../../src/util/suggest";
import { buildTeamStatusLine, buildTeamWidgetLines, hasAnimatedWorkers } from "../../src/ui/status-widget";
import type { LoadedTeamProjectConfig, PersistedTeamState, TeamConfig, WorkerRuntimeState } from "../../src/types";

const DelegateTaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the delegated task" }),
	goal: Type.String({ description: "What the worker should accomplish" }),
	profileName: Type.String({ description: "Worker profile name such as explorer, fixer, or reviewer" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Defaults to the current session cwd." })),
	contextHints: Type.Optional(Type.Array(Type.String(), { description: "Compact context bullets to pass into the worker" })),
	expectedOutput: Type.Optional(Type.String({ description: "Describe the output contract the worker should return" })),
	pathScopeRoots: Type.Optional(Type.Array(Type.String(), { description: "Allowed path roots for scoped workers, especially write-capable profiles." })),
	pathScopeAllowWrite: Type.Optional(Type.Boolean({ description: "Whether the delegated path scope may be written to." })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Optional list of Pi skill names (e.g. \"writer\", \"frontend-design\") the worker should invoke via its Skill tool. Skills come from the host Pi install (the [Skills] banner), not from team profiles. Omit if no specialized skill is needed." })),
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
	wakeOnRelay: Type.Optional(Type.Boolean({ description: "Return early with reason=relay_raised when any target raises a new relay question. Defaults to true so the orchestrator can answer mid-flight without waiting for every worker to finish." })),
});

function restoreLatestState(
	ctx: ExtensionContext,
	startReason: "startup" | "reload" | "new" | "resume" | "fork",
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): { state: PersistedTeamState; markedCount: number } {
	const restoredState = restorePersistedTeamState(
		ctx.sessionManager.getEntries(),
		config.persistence.stateCustomType,
	);
	const { state, markedCount } = markRestoredWorkersExited(restoredState, startReason);
	return { state, markedCount };
}

function applyUi(
	ctx: ExtensionContext | undefined,
	state: PersistedTeamState,
	frame = 0,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
	active = true,
): void {
	if (!ctx?.hasUI) return;
	if (!active) {
		ctx.ui.setStatus(config.ui.statusKey, undefined);
		ctx.ui.setWidget(config.ui.widgetKey, undefined);
		return;
	}

	const widgetLines = buildTeamWidgetLines(state, { frame });
	ctx.ui.setStatus(config.ui.statusKey, buildTeamStatusLine(state));
	ctx.ui.setWidget(config.ui.widgetKey, widgetLines.length > 0 ? widgetLines : undefined);
	ctx.ui.setTitle(config.ui.titleTemplate.replace("{mode}", state.sessionMode));
}

function clearUi(ctx: ExtensionContext | undefined, config: TeamConfig = DEFAULT_TEAM_CONFIG): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(config.ui.statusKey, undefined);
	ctx.ui.setWidget(config.ui.widgetKey, undefined);
}

function persistSnapshot(pi: ExtensionAPI, state: PersistedTeamState, config: TeamConfig = DEFAULT_TEAM_CONFIG): void {
	pi.appendEntry(config.persistence.stateCustomType, createPersistedStateSnapshot(state));
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
	if (summary?.headline) lines.push(`Headline: ${summary.headline}`);
	if (summary?.readFiles.length) lines.push(`Read files: ${truncateList(summary.readFiles, 10)}`);
	if (summary?.changedFiles.length) lines.push(`Changed files: ${truncateList(summary.changedFiles, 10)}`);
	if (summary?.risks.length) lines.push(`Risks: ${truncateList(summary.risks, 5)}`);
	if (summary?.nextRecommendation) lines.push(`Next: ${summary.nextRecommendation}`);

	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("", "Pending relay questions:");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
			lines.push(`  assumption: ${relay.assumption}`);
		}
	}

	lines.push(`Usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens} cost=$${worker.usage.costUsd.toFixed(4)}`);

	if (worker.finalAnswer && worker.finalAnswer.trim()) {
		lines.push("", "--- Final answer (from worker's <final_answer> block) ---", worker.finalAnswer.trim());
	} else {
		lines.push(
			"",
			`No <final_answer> block extracted yet. If the worker is idle and this is empty, it did not follow the final-answer contract — re-delegate or steer it with: \`Please wrap your final deliverable in <final_answer>…</final_answer> tags.\``,
		);
	}

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
	if (/\s/.test(prefix)) return [];
	return teamManager
		.listWorkers()
		.filter((worker) => worker.workerId.startsWith(prefix))
		.map((worker) => ({
			value: worker.workerId,
			label: worker.workerId,
			description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
		}));
}

function emitCommandOutput(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	text: string,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): void {
	if (ctx.hasUI) {
		pi.sendMessage({
			customType: config.persistence.statusMessageType,
			content: text,
			display: true,
		});
		return;
	}

	console.log(text);
}

function isTeamActive(config: LoadedTeamProjectConfig): boolean {
	return config.enabled && config.delegationEnabled;
}

function getDisabledMessage(config: LoadedTeamProjectConfig): string {
	const sourceLayer = config.layers.find((layer) => layer.scope === config.enabledSource);
	const path = sourceLayer?.path;
	const enableScope = config.enabledSource === "project" ? "local" : "global";
	const pathSuffix = path ? ` (source: ${path})` : "";
	return `Pi Agents Team is disabled${pathSuffix}. Use /team-enable ${enableScope} then /reload-plugins to turn it on.`;
}

function getProjectConfigNotice(result: LoadedTeamProjectConfig): { level: "info" | "warning"; message: string } | undefined {
	if (!result.enabled) {
		return { level: "info", message: getDisabledMessage(result) };
	}
	if (result.status === "project" && result.sourcePath) {
		return {
			level: "info",
			message: `Pi Agents Team: loaded session-frozen project config from ${result.sourcePath}.`,
		};
	}
	if (result.status === "invalid") {
		const firstError = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
		return {
			level: "warning",
			message: `Pi Agents Team: invalid agents-team.json — delegation disabled${firstError ? ` (${firstError.message})` : ""}.`,
		};
	}
	return undefined;
}

function getProjectConfigPromptNote(result: LoadedTeamProjectConfig): string | undefined {
	if (result.status === "project" && result.sourcePath) {
		return `- Session-frozen project role config loaded from ${result.sourcePath}. Treat those profiles as the active role config for this session.`;
	}
	if (result.status === "invalid") {
		const firstError = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
		return `- Project role config is invalid${result.sourcePath ? ` at ${result.sourcePath}` : ""}. Delegation is disabled until it is fixed.${firstError ? ` First error: ${firstError.message}.` : ""}`;
	}
	return undefined;
}

function getDelegationDisabledMessage(result: LoadedTeamProjectConfig): string {
	const firstError = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	return `Delegation is disabled because agents-team.json is invalid${result.sourcePath ? ` at ${result.sourcePath}` : ""}${firstError ? `: ${firstError.message}` : "."}`;
}

export default function (pi: ExtensionAPI): void {
	let activeProjectConfig = loadActiveTeamConfig({ cwd: process.cwd(), baseConfig: DEFAULT_TEAM_CONFIG });
	let teamManager = new TeamManager({ config: activeProjectConfig.config });
	let teamState = createDefaultTeamState(activeProjectConfig.config);
	let activeContext: ExtensionContext | undefined;
	let detachTeamManagerListener = () => {};
	const lastStatus = new Map<string, WorkerRuntimeState["status"]>();
	const lastRelayCount = new Map<string, number>();
	const pendingTerminalTransitions: Array<{ workerId: string; profileName: string; status: WorkerRuntimeState["status"] }> = [];
	let notificationTimer: NodeJS.Timeout | undefined;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let spinnerFrame = 0;
	const SPINNER_INTERVAL_MS = 120;

	function ensureSpinnerRunning(): void {
		if (spinnerTimer || !activeContext?.hasUI) return;
		if (!hasAnimatedWorkers(teamState)) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % 10;
			if (!activeContext?.hasUI || !hasAnimatedWorkers(teamState)) {
				stopSpinner();
				return;
			}
			applyUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig));
		}, SPINNER_INTERVAL_MS);
		if (typeof spinnerTimer.unref === "function") spinnerTimer.unref();
	}

	function stopSpinner(): void {
		if (!spinnerTimer) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}

	function resetUiTracking(): void {
		lastStatus.clear();
		lastRelayCount.clear();
		pendingTerminalTransitions.length = 0;
		if (notificationTimer) {
			clearTimeout(notificationTimer);
			notificationTimer = undefined;
		}
	}

	function flushTerminalNotifications(): void {
		notificationTimer = undefined;
		if (pendingTerminalTransitions.length === 0) return;
		const queued = pendingTerminalTransitions.splice(0);
		if (!activeContext?.hasUI) return;
		const items = queued.filter((item) => {
			const current = lastStatus.get(item.workerId);
			return current ? isTerminalWorkerStatus(current) : false;
		});
		if (items.length === 0) return;
		const message = items.length === 1
			? `✓ ${items[0].workerId} (${items[0].profileName}) finished: ${items[0].status}`
			: `✓ ${items.length} workers finished: ${items.map((i) => i.workerId).join(", ")}`;
		activeContext.ui.notify(message, "info");
	}

	function attachTeamManagerListener(manager: TeamManager): void {
		detachTeamManagerListener();
		resetUiTracking();
		detachTeamManagerListener = manager.onStateChange((state) => {
			teamState = state;
			persistSnapshot(pi, teamState, activeProjectConfig.config);
			applyUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig));

			if (hasAnimatedWorkers(teamState)) {
				ensureSpinnerRunning();
			} else {
				stopSpinner();
			}

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
					const question = newest?.question?.trim();
					if (question) {
						const preview = question.replace(/\s+/g, " ").slice(0, 120);
						activeContext.ui.notify(`❓ ${worker.workerId} (${worker.profileName}) needs guidance: ${preview}`, "warning");
					}
				}
				lastRelayCount.set(worker.workerId, currRelays);
			}
		});
	}

	async function replaceTeamManager(config: TeamConfig): Promise<void> {
		detachTeamManagerListener();
		await teamManager.dispose();
		teamManager = new TeamManager({ config });
		attachTeamManagerListener(teamManager);
		teamState = createDefaultTeamState(config);
		applyUi(activeContext, teamState, spinnerFrame, config, isTeamActive(activeProjectConfig));
	}

	attachTeamManagerListener(teamManager);

	const commandDependencies = {
		get teamManager() {
			return teamManager;
		},
		emitText: (ctx: ExtensionContext, text: string) => emitCommandOutput(pi, ctx, text, activeProjectConfig.config),
	};
	registerTeamCommand(pi, commandDependencies);
	registerWorkerMessageCommands(pi, commandDependencies);
	registerCancelCommand(pi, commandDependencies);
	registerCopyCommand(pi, commandDependencies);
	registerPruneCommand(pi, commandDependencies);
	registerCostCommand(pi, commandDependencies);

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
			const candidates = teamManager.listWorkers().map((worker) => worker.workerId);
			if (!resolved) {
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const result = teamManager.getWorkerResult(resolved);
			if (!result) {
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const transcript = teamManager.getWorkerTranscript(resolved);
			emitCommandOutput(pi, ctx, formatWorkerDetail(result.worker, transcript), activeProjectConfig.config);
		},
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Launch a background Pi RPC worker for a bounded delegated task and track it in the orchestrator state.",
		parameters: DelegateTaskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeProjectConfig.enabled) {
				throw new Error(getDisabledMessage(activeProjectConfig));
			}
			if (!activeProjectConfig.delegationEnabled) {
				throw new Error(getDelegationDisabledMessage(activeProjectConfig));
			}
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
				skills: params.skills,
				model: params.model,
				orchestratorModel,
			});
			teamState = teamManager.snapshot();
			applyUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig));
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
		description: "Get the worker's final deliverable: structured summary header (headline/files/risks/next) plus the verbatim contents of the worker's <final_answer>…</final_answer> block. This is the authoritative answer — synthesize directly from it. If the final_answer block is empty, the worker did not follow the contract; re-delegate with smaller scope instead of reading files yourself.",
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
		description: "Block until every target worker reaches a terminal status (idle, exited, aborted, error) or until a target raises a new relay question. Also honors a timeout. Returns reason=all_terminal, relay_raised (with newRelays listed), timeout, or aborted. Prefer this over repeated ping_agents polling — it consumes no tokens while waiting. Use it after delegate_task; when it returns relay_raised, answer via agent_message and call wait_for_agents again to resume.",
		parameters: WaitForAgentsSchema,
		async execute(_toolCallId, params, signal) {
			const targetIds = params.workerIds?.length
				? params.workerIds.map((id) => teamManager.resolveWorkerId(id) ?? id)
				: teamManager.listWorkers().map((worker) => worker.workerId);
			type NewRelay = { workerId: string; profileName: string; question: string; urgency: string };
			type WaitDetails = {
				reason: "all_terminal" | "timeout" | "aborted" | "relay_raised" | "no_workers";
				workers: WorkerRuntimeState[];
				newRelays?: NewRelay[];
			};
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
				wakeOnRelay: params.wakeOnRelay !== false,
			});
			let header: string;
			if (result.reason === "all_terminal") {
				header = `All ${result.workers.length} worker(s) reached terminal status.`;
			} else if (result.reason === "relay_raised") {
				const count = result.newRelays?.length ?? 0;
				header = `${count} new relay question(s) raised — answer via agent_message, then call wait_for_agents again to resume.`;
			} else if (result.reason === "timeout") {
				header = "Wait timed out; some workers may still be running.";
			} else {
				header = "Wait aborted.";
			}
			const relayLines = (result.newRelays ?? []).map(
				(relay) => `  ! ${relay.workerId} (${relay.profileName}) [${relay.urgency}] ${relay.question}`,
			);
			const details: WaitDetails = { reason: result.reason, workers: result.workers };
			if (result.newRelays) details.newRelays = result.newRelays;
			return {
				content: [{ type: "text", text: [header, ...relayLines, formatWorkers(result.workers)].join("\n") }],
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
		activeProjectConfig = loadActiveTeamConfig({ cwd: ctx.cwd, baseConfig: DEFAULT_TEAM_CONFIG });
		await replaceTeamManager(activeProjectConfig.config);
		const { state, markedCount } = restoreLatestState(ctx, event.reason, activeProjectConfig.config);
		teamState = state;
		teamManager.restore(teamState);
		applyUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig));
		persistSnapshot(pi, teamState, activeProjectConfig.config);

		if (!ctx.hasUI) return;

		if (activeProjectConfig.enabled) {
			ctx.ui.notify("Pi Agents Team loaded: this session is running in orchestrator mode.", "info");
		}
		const configNotice = getProjectConfigNotice(activeProjectConfig);
		if (configNotice) {
			ctx.ui.notify(configNotice.message, configNotice.level);
		}

		if (event.reason !== "startup" && markedCount > 0 && isTeamActive(activeProjectConfig)) {
			const noun = markedCount === 1 ? "worker" : "workers";
			ctx.ui.notify(
				`Pi Agents Team: ${markedCount} ${noun} from prior session marked exited (${event.reason}). Relaunch via delegate_task if still needed.`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeContext = ctx;
		teamState = teamManager.snapshot();
		applyUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig));
		if (!activeProjectConfig.enabled) {
			return { systemPrompt: event.systemPrompt };
		}
		const projectConfigPromptNote = getProjectConfigPromptNote(activeProjectConfig);
		return {
			systemPrompt: [
				event.systemPrompt,
				buildOrchestratorPromptBundle(teamState, activeProjectConfig.config),
				projectConfigPromptNote,
			].filter((item): item is string => Boolean(item)).join("\n\n"),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinner();
		detachTeamManagerListener();
		await teamManager.dispose();
		teamState = teamManager.snapshot();
		persistSnapshot(pi, teamState, activeProjectConfig.config);
		clearUi(ctx, activeProjectConfig.config);
		activeContext = undefined;
	});
}
