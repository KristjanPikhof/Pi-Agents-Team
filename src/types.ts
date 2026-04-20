export const TEAM_STATE_VERSION = 1 as const;

export const TEAM_SESSION_MODES = ["orchestrator", "worker"] as const;
export type TeamSessionMode = (typeof TEAM_SESSION_MODES)[number];

export const TEAM_PROFILE_NAMES = [
	"explorer",
	"librarian",
	"oracle",
	"designer",
	"fixer",
	"reviewer",
	"observer",
] as const;
export type TeamProfileName = (typeof TEAM_PROFILE_NAMES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const WORKER_EXTENSION_MODES = ["inherit", "disable", "worker-minimal"] as const;
export type WorkerExtensionMode = (typeof WORKER_EXTENSION_MODES)[number];

export const WORKER_WRITE_POLICIES = ["read-only", "scoped-write"] as const;
export type WorkerWritePolicy = (typeof WORKER_WRITE_POLICIES)[number];

export const WORKER_STATUSES = [
	"created",
	"starting",
	"idle",
	"running",
	"waiting_followup",
	"completed",
	"aborted",
	"error",
	"exited",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const TEAM_TASK_STATUSES = [
	"queued",
	"running",
	"waiting_followup",
	"completed",
	"blocked",
	"failed",
	"cancelled",
] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const RELAY_URGENCIES = ["low", "medium", "high"] as const;
export type RelayUrgency = (typeof RELAY_URGENCIES)[number];

export const PING_MODES = ["passive", "active"] as const;
export type PingMode = (typeof PING_MODES)[number];

export interface TeamPathScope {
	roots: string[];
	allowReadOutsideRoots: boolean;
	allowWrite: boolean;
}

export interface TeamProfileSpec {
	name: TeamProfileName | string;
	description: string;
	model?: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	promptPath: string;
	extensionMode: WorkerExtensionMode;
	writePolicy: WorkerWritePolicy;
	pathScope?: TeamPathScope;
	canSpawnWorkers: boolean;
}

export interface DelegatedTaskInput {
	taskId: string;
	title: string;
	goal: string;
	requestedBy: "user" | "orchestrator" | "operator";
	profileName: string;
	cwd: string;
	contextHints: string[];
	expectedOutput?: string;
	pathScope?: TeamPathScope;
	createdAt: number;
}

export interface WorkerUsageStats {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	contextTokens?: number;
}

export interface RelayQuestion {
	relayId: string;
	workerId: string;
	taskId: string;
	question: string;
	assumption: string;
	urgency: RelayUrgency;
	choices?: string[];
	createdAt: number;
	resolvedAt?: number;
	resolution?: string;
}

export interface WorkerSummary {
	workerId: string;
	taskId: string;
	headline: string;
	status: WorkerStatus;
	currentToolName?: string;
	readFiles: string[];
	changedFiles: string[];
	risks: string[];
	nextRecommendation?: string;
	relayQuestionCount: number;
	updatedAt: number;
}

export interface WorkerRuntimeState {
	workerId: string;
	profileName: string;
	sessionMode: TeamSessionMode;
	status: WorkerStatus;
	processId?: number;
	startedAt: number;
	lastEventAt: number;
	lastToolName?: string;
	currentTask?: DelegatedTaskInput;
	lastSummary?: WorkerSummary;
	pendingRelayQuestions: RelayQuestion[];
	usage: WorkerUsageStats;
	error?: string;
}

export interface TeamDashboardEntry {
	workerId: string;
	profileName: string;
	status: WorkerStatus;
	taskTitle?: string;
	currentToolName?: string;
	summarySnippet?: string;
	relayQuestionCount: number;
	lastUpdateAt: number;
}

export interface TeamUiState {
	statusKey: string;
	widgetKey: string;
	overlayOpen: boolean;
	selectedWorkerId?: string;
	dashboardEntries: TeamDashboardEntry[];
	lastRenderAt: number;
}

export interface TeamConfig {
	version: typeof TEAM_STATE_VERSION;
	sessionMode: TeamSessionMode;
	orchestration: {
		packageName: string;
		extensionName: string;
		systemPromptTitle: string;
		systemPromptNotes: string[];
	};
	rpc: {
		command: string;
		args: string[];
		mode: "rpc";
		noSession: boolean;
		transport: "jsonl-lf";
	};
	summaries: {
		maxHeadlineLength: number;
		maxItemsPerWorker: number;
		maxChangedFiles: number;
		maxRelayQuestions: number;
	};
	ui: {
		statusKey: string;
		widgetKey: string;
		titleTemplate: string;
		maxVisibleWorkers: number;
		showProfileNames: boolean;
	};
	safety: {
		preventRecursiveOrchestrator: boolean;
		defaultWorkerExtensionMode: WorkerExtensionMode;
		requirePathScopeForWrites: boolean;
		allowProjectProfiles: boolean;
	};
	persistence: {
		stateCustomType: string;
		statusMessageType: string;
		storeTranscripts: boolean;
	};
	profiles: TeamProfileSpec[];
}

export interface PersistedTeamState {
	version: typeof TEAM_STATE_VERSION;
	sessionMode: TeamSessionMode;
	activeWorkers: Record<string, WorkerRuntimeState>;
	taskRegistry: Record<string, DelegatedTaskInput>;
	relayQueue: RelayQuestion[];
	ui: TeamUiState;
	updatedAt: number;
}
