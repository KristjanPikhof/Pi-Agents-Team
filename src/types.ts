export const TEAM_STATE_VERSION = 1 as const;

export const TEAM_SESSION_MODES = ["orchestrator", "worker"] as const;
export type TeamSessionMode = (typeof TEAM_SESSION_MODES)[number];

/**
 * Names the plugin ships packaged `prompts/agents/<name>.md` prompts for.
 * In schema v2, these are NOT a ceiling — users may rename, drop, or add roles
 * freely. This list is only used for two things:
 *   1. The default `/team-init` scaffold seeds these role keys so first-time
 *      operators see a sensible starting point.
 *   2. When `role.prompt === "default"`, the loader looks for a packaged prompt
 *      at `prompts/agents/<roleName>.md`. Matching names get the packaged file;
 *      custom names get the generic worker template.
 */
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

export function isPackagedProfileName(name: string): name is TeamProfileName {
	return (TEAM_PROFILE_NAMES as readonly string[]).includes(name);
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const WORKER_EXTENSION_MODES = ["inherit", "disable", "worker-minimal"] as const;
export type WorkerExtensionMode = (typeof WORKER_EXTENSION_MODES)[number];

export const WORKER_WRITE_POLICIES = ["read-only", "scoped-write"] as const;
export type WorkerWritePolicy = (typeof WORKER_WRITE_POLICIES)[number];

// The JSON field name for the schema contract is `schemaVersion`. Bump this
// when the shape of agents-team.json changes in a way an older loader can't
// correctly interpret (renamed fields, new required fields, changed semantics).
// Mismatched files emit a warning toast and fall back to built-in roles for
// that layer until the user runs /team-init <scope> --force.
export const TEAM_PROJECT_SCHEMA_VERSION = 3 as const;
export const TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED = [3] as const;
// The JSON field name for the freshness marker is `scaffoldVersion`. Bump this
// when /team-init would write different defaults (new role, tweaked tool list,
// new default description) even though the shape is identical. Older files
// keep loading; each layer where scaffoldVersion < CURRENT_SCAFFOLD_VERSION
// gets a soft "stale scaffold" toast suggesting re-init.
export const TEAM_SCAFFOLD_VERSION = 3 as const;
export const DEFAULT_MODEL_SENTINEL = "default" as const;
export const DEFAULT_PROMPT_SENTINEL = "default" as const;
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
	/**
	 * Path to the worker prompt markdown. May be the literal string
	 * "<generic-worker>" — a sentinel that tells the prompt loader to use the
	 * packaged generic-worker template with the role's name+description
	 * substituted in. Ignored when `promptInline` is set.
	 */
	promptPath: string;
	/**
	 * Inline prompt text, used when the user sets `"prompt": "<prose>"` in
	 * agents-team.json for strings that don't resolve to a readable file.
	 * Overrides `promptPath` when present.
	 */
	promptInline?: string;
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

export interface ProjectRoleAdvancedConfig {
	extensionMode?: WorkerExtensionMode;
	canSpawnWorkers?: boolean;
	pathScope?: TeamPathScope;
}

/**
 * Flat shape emitted by /team-init (schemaVersion 3+). Easier for operators:
 * top-level `tools`, `write: true|false`, `prompt: "default" | "<path>"`,
 * `model: "default" | "<provider/id>"`. Power-user knobs live in `advanced`.
 *
 * `whenToUse` is the canonical field for telling the orchestrator when to
 * delegate to this role — write it as a trigger sentence ("Use when..."),
 * not a passive description of capability. The legacy `description` alias is
 * accepted for backcompat; `whenToUse` wins when both are present.
 */
export interface ProjectRoleFlatConfig {
	whenToUse?: string | null;
	description?: string | null;
	model?: string | null;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	write?: boolean;
	prompt?: string | null | ProjectRolePromptConfig;
	advanced?: ProjectRoleAdvancedConfig;
}

export type RawProjectRoleConfig = ProjectRoleConfig | ProjectRoleFlatConfig;

// Schema v2: role keys are free-form strings. The user owns the map.
export type ProjectRoleConfigMap = Record<string, ProjectRoleConfig>;
export type PartialProjectRoleConfigMap = Record<string, ProjectRoleConfig>;
export type PartialRawProjectRoleConfigMap = Record<string, RawProjectRoleConfig>;

export interface TeamProjectConfigFile {
	schemaVersion: typeof TEAM_PROJECT_SCHEMA_VERSION;
	scaffoldVersion?: number;
	enabled?: boolean;
	roles?: PartialRawProjectRoleConfigMap;
}

export interface TeamProjectConfigLayer {
	scope: TeamConfigScope;
	path: string;
	enabled?: boolean;
	scaffoldVersion?: number;
	scaffoldStale?: boolean;
	/** True when the file's `schemaVersion` is outside TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED. */
	schemaMismatch?: boolean;
	/** The raw `schemaVersion` value found in the file, for toast messaging. */
	rawSchemaVersion?: number;
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
