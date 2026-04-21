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

export const TEAM_PROJECT_CONFIG_VERSION = 1 as const;
// Snapshot freshness marker stamped into scaffolded configs. Bump whenever
// DEFAULT_TEAM_CONFIG.profiles changes so previously-scaffolded agents-team.json
// files are detected as stale and the operator is nudged to re-run /team-init.
export const TEAM_DEFAULTS_VERSION = 1 as const;
export const TEAM_PROJECT_CONFIG_FILE = "agents-team.json";
export const TEAM_PROJECT_CONFIG_DIR = ".pi/agent";
export const TEAM_PROJECT_CONFIG_RELATIVE_PATH = `${TEAM_PROJECT_CONFIG_DIR}/${TEAM_PROJECT_CONFIG_FILE}`;
export const TEAM_CONFIG_SCOPES = ["global", "project"] as const;
export type TeamConfigScope = (typeof TEAM_CONFIG_SCOPES)[number];
export const TEAM_ENABLED_SOURCES = ["default", "global", "project"] as const;
export type TeamEnabledSource = (typeof TEAM_ENABLED_SOURCES)[number];
export const TEAM_PROMPT_SOURCES = ["builtin", "project"] as const;
export type TeamPromptSource = (typeof TEAM_PROMPT_SOURCES)[number];

export const PROJECT_CONFIG_STATUSES = ["builtin", "project", "invalid"] as const;
export type ProjectConfigStatus = (typeof PROJECT_CONFIG_STATUSES)[number];

export const PROJECT_CONFIG_DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export type ProjectConfigDiagnosticSeverity = (typeof PROJECT_CONFIG_DIAGNOSTIC_SEVERITIES)[number];

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

export function compareWorkerIds(a: string, b: string): number {
	const am = /^w(\d+)$/.exec(a);
	const bm = /^w(\d+)$/.exec(b);
	if (am && bm) return Number(am[1]) - Number(bm[1]);
	if (am) return -1;
	if (bm) return 1;
	return a.localeCompare(b);
}

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

export interface ProjectRolePermissions {
	tools?: string[] | null;
	extensionMode?: WorkerExtensionMode;
	writePolicy?: WorkerWritePolicy;
	pathScope?: TeamPathScope;
	canSpawnWorkers?: boolean;
}

export interface ProjectRolePromptConfig {
	source: TeamPromptSource;
	path?: string | null;
}

export interface ProjectRoleConfig {
	description?: string | null;
	model?: string | null;
	thinkingLevel?: ThinkingLevel;
	permissions: ProjectRolePermissions;
	prompt: ProjectRolePromptConfig;
}

export type ProjectRoleConfigMap = Record<TeamProfileName, ProjectRoleConfig>;
export type PartialProjectRoleConfigMap = Partial<Record<TeamProfileName, ProjectRoleConfig>>;

export interface TeamProjectConfigFile {
	version: typeof TEAM_PROJECT_CONFIG_VERSION;
	defaultsVersion?: number;
	enabled?: boolean;
	roles?: PartialProjectRoleConfigMap;
}

export interface TeamProjectConfigLayer {
	scope: TeamConfigScope;
	path: string;
	enabled?: boolean;
	defaultsVersion?: number;
	defaultsStale?: boolean;
}

export interface ProjectConfigDiagnostic {
	severity: ProjectConfigDiagnosticSeverity;
	code: string;
	message: string;
	fieldPath?: string;
}

export interface LoadedTeamProjectConfig {
	status: ProjectConfigStatus;
	config: TeamConfig;
	sourcePath?: string;
	projectRoot?: string;
	layers: TeamProjectConfigLayer[];
	enabled: boolean;
	enabledSource: TeamEnabledSource;
	diagnostics: ProjectConfigDiagnostic[];
	delegationEnabled: boolean;
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
	skills?: string[];
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
	finalAnswer?: string;
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
		projectRoot?: string;
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
