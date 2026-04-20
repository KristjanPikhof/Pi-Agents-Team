import { Type, type TSchema } from "@sinclair/typebox";
import {
	compareWorkerIds,
	PING_MODES,
	RELAY_URGENCIES,
	TEAM_PROFILE_NAMES,
	TEAM_SESSION_MODES,
	TEAM_STATE_VERSION,
	TEAM_TASK_STATUSES,
	THINKING_LEVELS,
	WORKER_EXTENSION_MODES,
	WORKER_STATUSES,
	WORKER_WRITE_POLICIES,
	type PersistedTeamState,
	type TeamConfig,
	type TeamDashboardEntry,
	type WorkerRuntimeState,
} from "./types";

function enumSchema<const T extends readonly [string, ...string[]]>(values: T): TSchema {
	return Type.Union(values.map((value) => Type.Literal(value)) as []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const TeamPathScopeSchema = Type.Object({
	roots: Type.Array(Type.String()),
	allowReadOutsideRoots: Type.Boolean({ default: false }),
	allowWrite: Type.Boolean({ default: false }),
});

export const TeamProfileSpecSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	model: Type.Optional(Type.String()),
	thinkingLevel: enumSchema(THINKING_LEVELS),
	tools: Type.Array(Type.String()),
	promptPath: Type.String(),
	extensionMode: enumSchema(WORKER_EXTENSION_MODES),
	writePolicy: enumSchema(WORKER_WRITE_POLICIES),
	pathScope: Type.Optional(TeamPathScopeSchema),
	canSpawnWorkers: Type.Boolean({ default: false }),
});

export const WorkerUsageStatsSchema = Type.Object({
	turns: Type.Number({ default: 0 }),
	inputTokens: Type.Number({ default: 0 }),
	outputTokens: Type.Number({ default: 0 }),
	cacheReadTokens: Type.Number({ default: 0 }),
	cacheWriteTokens: Type.Number({ default: 0 }),
	costUsd: Type.Number({ default: 0 }),
	contextTokens: Type.Optional(Type.Number()),
});

export const RelayQuestionSchema = Type.Object({
	relayId: Type.String(),
	workerId: Type.String(),
	taskId: Type.String(),
	question: Type.String(),
	assumption: Type.String(),
	urgency: enumSchema(RELAY_URGENCIES),
	choices: Type.Optional(Type.Array(Type.String())),
	createdAt: Type.Number(),
	resolvedAt: Type.Optional(Type.Number()),
	resolution: Type.Optional(Type.String()),
});

export const WorkerSummarySchema = Type.Object({
	workerId: Type.String(),
	taskId: Type.String(),
	headline: Type.String(),
	status: enumSchema(WORKER_STATUSES),
	currentToolName: Type.Optional(Type.String()),
	readFiles: Type.Array(Type.String()),
	changedFiles: Type.Array(Type.String()),
	risks: Type.Array(Type.String()),
	nextRecommendation: Type.Optional(Type.String()),
	relayQuestionCount: Type.Number({ default: 0 }),
	updatedAt: Type.Number(),
});

export const DelegatedTaskInputSchema = Type.Object({
	taskId: Type.String(),
	title: Type.String(),
	goal: Type.String(),
	requestedBy: enumSchema(["user", "orchestrator", "operator"]),
	profileName: Type.String(),
	cwd: Type.String(),
	contextHints: Type.Array(Type.String()),
	expectedOutput: Type.Optional(Type.String()),
	pathScope: Type.Optional(TeamPathScopeSchema),
	createdAt: Type.Number(),
});

export const WorkerRuntimeStateSchema = Type.Object({
	workerId: Type.String(),
	profileName: Type.String(),
	sessionMode: enumSchema(TEAM_SESSION_MODES),
	status: enumSchema(WORKER_STATUSES),
	processId: Type.Optional(Type.Number()),
	startedAt: Type.Number(),
	lastEventAt: Type.Number(),
	lastToolName: Type.Optional(Type.String()),
	currentTask: Type.Optional(DelegatedTaskInputSchema),
	lastSummary: Type.Optional(WorkerSummarySchema),
	finalAnswer: Type.Optional(Type.String()),
	pendingRelayQuestions: Type.Array(RelayQuestionSchema),
	usage: WorkerUsageStatsSchema,
	error: Type.Optional(Type.String()),
});

export const TeamDashboardEntrySchema = Type.Object({
	workerId: Type.String(),
	profileName: Type.String(),
	status: enumSchema(WORKER_STATUSES),
	taskTitle: Type.Optional(Type.String()),
	currentToolName: Type.Optional(Type.String()),
	summarySnippet: Type.Optional(Type.String()),
	relayQuestionCount: Type.Number({ default: 0 }),
	lastUpdateAt: Type.Number(),
});

export const TeamUiStateSchema = Type.Object({
	statusKey: Type.String(),
	widgetKey: Type.String(),
	overlayOpen: Type.Boolean({ default: false }),
	selectedWorkerId: Type.Optional(Type.String()),
	dashboardEntries: Type.Array(TeamDashboardEntrySchema),
	lastRenderAt: Type.Number(),
});

export const TeamConfigSchema = Type.Object({
	version: Type.Literal(TEAM_STATE_VERSION),
	sessionMode: enumSchema(TEAM_SESSION_MODES),
	orchestration: Type.Object({
		packageName: Type.String(),
		extensionName: Type.String(),
		systemPromptTitle: Type.String(),
		systemPromptNotes: Type.Array(Type.String()),
	}),
	rpc: Type.Object({
		command: Type.String(),
		args: Type.Array(Type.String()),
		mode: Type.Literal("rpc"),
		noSession: Type.Boolean({ default: true }),
		transport: Type.Literal("jsonl-lf"),
	}),
	summaries: Type.Object({
		maxHeadlineLength: Type.Number({ minimum: 1 }),
		maxItemsPerWorker: Type.Number({ minimum: 1 }),
		maxChangedFiles: Type.Number({ minimum: 1 }),
		maxRelayQuestions: Type.Number({ minimum: 1 }),
	}),
	ui: Type.Object({
		statusKey: Type.String(),
		widgetKey: Type.String(),
		titleTemplate: Type.String(),
		maxVisibleWorkers: Type.Number({ minimum: 1 }),
		showProfileNames: Type.Boolean({ default: true }),
	}),
	safety: Type.Object({
		preventRecursiveOrchestrator: Type.Boolean({ default: true }),
		defaultWorkerExtensionMode: enumSchema(WORKER_EXTENSION_MODES),
		requirePathScopeForWrites: Type.Boolean({ default: true }),
		allowProjectProfiles: Type.Boolean({ default: false }),
	}),
	persistence: Type.Object({
		stateCustomType: Type.String(),
		statusMessageType: Type.String(),
		storeTranscripts: Type.Boolean({ default: false }),
	}),
	profiles: Type.Array(TeamProfileSpecSchema),
});

export const PersistedTeamStateSchema = Type.Object({
	version: Type.Literal(TEAM_STATE_VERSION),
	sessionMode: enumSchema(TEAM_SESSION_MODES),
	activeWorkers: Type.Record(Type.String(), WorkerRuntimeStateSchema),
	taskRegistry: Type.Record(Type.String(), DelegatedTaskInputSchema),
	relayQueue: Type.Array(RelayQuestionSchema),
	ui: TeamUiStateSchema,
	updatedAt: Type.Number(),
});

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
	version: TEAM_STATE_VERSION,
	sessionMode: "orchestrator",
	orchestration: {
		packageName: "Pi Agent Team",
		extensionName: "pi-agent-team",
		systemPromptTitle: "Pi Agent Team Orchestrator Mode",
		systemPromptNotes: [
			"The visible Pi session is the orchestrator and owns all user-facing dialogue.",
			"Worker agents are subordinate RPC peers that report compact summaries instead of raw transcripts.",
			"Delegation is the default. Only act directly on trivial single-step asks; all investigation, review, mapping, and multi-file work goes to workers via delegate_task.",
			"When the user asks for N workers or parallel analysis, spawn them immediately in one batch — do not pre-explore the repo yourself to decide what to delegate.",
			"After delegate_task, call wait_for_agents to block until workers finish. Do not poll with ping_agents and never sleep in bash — wait_for_agents consumes no tokens while waiting.",
			"Worker completion toasts (✓ ...) are UI-only and are not part of your conversation — ignore them; do not reply to them or re-call agent_result after you already have the summary.",
			"agent_result returns the worker's full <final_answer> block verbatim plus a small header. Synthesize from that. If the block is empty, re-delegate with smaller slices or steer the worker — never run bash/read/grep yourself to fill the gap.",
			"Delegation must stay explicit, safe, and scoped to profiles plus path ownership.",
		],
	},
	rpc: {
		command: "pi",
		args: ["--mode", "rpc", "--no-session"],
		mode: "rpc",
		noSession: true,
		transport: "jsonl-lf",
	},
	summaries: {
		maxHeadlineLength: 160,
		maxItemsPerWorker: 3,
		maxChangedFiles: 8,
		maxRelayQuestions: 3,
	},
	ui: {
		statusKey: "pi-agent-team",
		widgetKey: "pi-agent-team",
		titleTemplate: "pi - Pi Agent Team ({mode})",
		maxVisibleWorkers: 4,
		showProfileNames: true,
	},
	safety: {
		preventRecursiveOrchestrator: true,
		defaultWorkerExtensionMode: "worker-minimal",
		requirePathScopeForWrites: true,
		allowProjectProfiles: false,
	},
	persistence: {
		stateCustomType: "pi-agent-team/state",
		statusMessageType: "pi-agent-team/status",
		storeTranscripts: false,
	},
	profiles: [
		{
			name: TEAM_PROFILE_NAMES[0],
			description: "Fast codebase reconnaissance and file discovery.",
			thinkingLevel: "low",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/explorer.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[1],
			description: "Docs, APIs, and version-sensitive reference research.",
			thinkingLevel: "medium",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/librarian.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[2],
			description: "Architecture, debugging, and review-heavy judgement.",
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/oracle.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[3],
			description: "UI and interaction design guidance.",
			thinkingLevel: "medium",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/designer.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[4],
			description: "Bounded implementation, tests, and targeted edits.",
			thinkingLevel: "medium",
			tools: ["read", "bash", "edit", "write"],
			promptPath: "prompts/agents/fixer.md",
			extensionMode: "worker-minimal",
			writePolicy: "scoped-write",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[5],
			description: "Validation, critique, and regression review.",
			thinkingLevel: "medium",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/reviewer.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
		{
			name: TEAM_PROFILE_NAMES[6],
			description: "Observation-oriented worker for screenshots and non-code artifacts.",
			thinkingLevel: "low",
			tools: ["read", "grep", "find", "ls", "bash"],
			promptPath: "prompts/agents/observer.md",
			extensionMode: "worker-minimal",
			writePolicy: "read-only",
			canSpawnWorkers: false,
		},
	],
};

export function createDefaultTeamState(config: TeamConfig = DEFAULT_TEAM_CONFIG, now = Date.now()): PersistedTeamState {
	return {
		version: TEAM_STATE_VERSION,
		sessionMode: config.sessionMode,
		activeWorkers: {},
		taskRegistry: {},
		relayQueue: [],
		ui: {
			statusKey: config.ui.statusKey,
			widgetKey: config.ui.widgetKey,
			overlayOpen: false,
			dashboardEntries: [],
			lastRenderAt: now,
		},
		updatedAt: now,
	};
}

export function normalizePersistedTeamState(
	raw: unknown,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): PersistedTeamState {
	const base = createDefaultTeamState(config);
	if (!isRecord(raw)) return base;

	const activeWorkers = isRecord(raw.activeWorkers)
		? (raw.activeWorkers as Record<string, WorkerRuntimeState>)
		: base.activeWorkers;
	const taskRegistry = isRecord(raw.taskRegistry) ? (raw.taskRegistry as PersistedTeamState["taskRegistry"]) : base.taskRegistry;
	const relayQueue = Array.isArray(raw.relayQueue) ? (raw.relayQueue as PersistedTeamState["relayQueue"]) : base.relayQueue;
	const rawUi = isRecord(raw.ui) ? raw.ui : {};

	return {
		...base,
		sessionMode: raw.sessionMode === "worker" ? "worker" : base.sessionMode,
		activeWorkers,
		taskRegistry,
		relayQueue,
		ui: {
			...base.ui,
			statusKey: typeof rawUi.statusKey === "string" ? rawUi.statusKey : base.ui.statusKey,
			widgetKey: typeof rawUi.widgetKey === "string" ? rawUi.widgetKey : base.ui.widgetKey,
			overlayOpen: rawUi.overlayOpen === true,
			selectedWorkerId: typeof rawUi.selectedWorkerId === "string" ? rawUi.selectedWorkerId : undefined,
			dashboardEntries: Array.isArray(rawUi.dashboardEntries)
				? (rawUi.dashboardEntries as TeamDashboardEntry[])
				: buildDashboardEntries(activeWorkers),
			lastRenderAt: typeof rawUi.lastRenderAt === "number" ? rawUi.lastRenderAt : base.ui.lastRenderAt,
		},
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : base.updatedAt,
	};
}

export function buildDashboardEntries(activeWorkers: Record<string, WorkerRuntimeState>): TeamDashboardEntry[] {
	return Object.values(activeWorkers)
		.sort((left, right) => compareWorkerIds(left.workerId, right.workerId))
		.map((worker) => ({
			workerId: worker.workerId,
			profileName: worker.profileName,
			status: worker.status,
			taskTitle: worker.currentTask?.title,
			currentToolName: worker.lastToolName ?? worker.lastSummary?.currentToolName,
			summarySnippet: worker.lastSummary?.headline,
			relayQuestionCount: worker.pendingRelayQuestions.length,
			lastUpdateAt: worker.lastEventAt,
		}));
}

export function formatWorkerLabel(worker: TeamDashboardEntry): string {
	const parts = [`${worker.profileName}:${worker.status}`];
	if (worker.taskTitle) parts.push(worker.taskTitle);
	if (worker.currentToolName) parts.push(`tool=${worker.currentToolName}`);
	if (worker.relayQuestionCount > 0) parts.push(`relays=${worker.relayQuestionCount}`);
	return parts.join(" · ");
}

export function buildTeamWidgetLines(
	state: PersistedTeamState,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): string[] {
	const entries = state.ui.dashboardEntries.length > 0 ? state.ui.dashboardEntries : buildDashboardEntries(state.activeWorkers);
	const visibleEntries = entries.slice(0, config.ui.maxVisibleWorkers);
	const lines = [
		`${config.orchestration.packageName}`,
		`mode: ${state.sessionMode}`,
		`workers: ${entries.length} active`,
	];

	if (visibleEntries.length === 0) {
		lines.push("workers: none launched yet");
	} else {
		for (const worker of visibleEntries) {
			lines.push(`- ${formatWorkerLabel(worker)}`);
		}
	}

	if (config.ui.showProfileNames) {
		lines.push(`profiles: ${config.profiles.map((profile) => profile.name).join(", ")}`);
	}

	return lines;
}

export function renderTeamStatusText(
	state: PersistedTeamState,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): string {
	const workerEntries = state.ui.dashboardEntries.length > 0 ? state.ui.dashboardEntries : buildDashboardEntries(state.activeWorkers);
	const lines = [
		`${config.orchestration.packageName}`,
		`session mode: ${state.sessionMode}`,
		`rpc launch: ${[config.rpc.command, ...config.rpc.args].join(" ")}`,
		`profiles: ${config.profiles.map((profile) => profile.name).join(", ")}`,
		`active workers: ${workerEntries.length}`,
		"runtime status: orchestrator prompt, runtime RPC worker control, and compact state tracking are active.",
	];

	for (const worker of workerEntries.slice(0, config.ui.maxVisibleWorkers)) {
		lines.push(`- ${formatWorkerLabel(worker)}`);
	}

	return lines.join("\n");
}

export function buildOrchestratorSystemPrompt(
	state: PersistedTeamState,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): string {
	const profileList = config.profiles.map((profile) => profile.name).join(", ");
	const activeWorkerCount = Object.keys(state.activeWorkers).length;
	const relayCount = state.relayQueue.length;

	return [
		`# ${config.orchestration.systemPromptTitle}`,
		"",
		...config.orchestration.systemPromptNotes.map((note) => `- ${note}`),
		"- If worker-control tools are not available yet, do not pretend background workers ran; work directly and explain the scaffold status when relevant.",
		"- When delegation becomes available, prefer bounded tasks with explicit profile choice, cwd, output contract, and compact summaries.",
		`- Available profile names: ${profileList}.`,
		`- Active worker count in this session snapshot: ${activeWorkerCount}.`,
		`- Pending relay questions in this session snapshot: ${relayCount}.`,
		`- Worker transport contract: ${config.rpc.transport} via ${[config.rpc.command, ...config.rpc.args].join(" ")}.`,
		`- Safety defaults: recursion prevention=${String(config.safety.preventRecursiveOrchestrator)}, require path scope for writes=${String(config.safety.requirePathScopeForWrites)}.`,
	].join("\n");
}

export const FOUNDATION_STATUS = {
	implementedTaskStatuses: TEAM_TASK_STATUSES,
	implementedWorkerStatuses: WORKER_STATUSES,
	implementedPingModes: PING_MODES,
};
