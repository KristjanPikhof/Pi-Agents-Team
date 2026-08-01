import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, truncateSync, unlinkSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CURRENT_SCAFFOLD_VERSION, DEFAULT_TEAM_CONFIG, createDefaultTeamState } from "../../src/config.js";
import {
	CompactPersistenceJournal,
	compactPersistenceRecordPayloadBytes,
	markRestoredWorkersExited,
	restorePersistedTeamStateWithMeasurement,
	type CompactPersistenceMeasurement,
} from "../../src/control-plane/persistence.js";
import { buildOrchestratorPromptBundle } from "../../src/prompts/contracts.js";
import { TeamManager, isTerminalWorkerStatus, type AgentResult } from "../../src/control-plane/team-manager.js";
import { loadActiveTeamConfig } from "../../src/project-config/loader.js";
import { registerCopyCommand } from "../../src/commands/copy.js";
import { registerTeamCommand } from "../../src/commands/team.js";
import { registerTeamEnableCommand } from "../../src/commands/team-enable.js";
import { registerTeamInitCommand } from "../../src/commands/team-init.js";
import { registerTeamResultCommand } from "../../src/commands/team-result.js";
import { registerTeamSteerCommand } from "../../src/commands/team-steer.js";
import { registerTeamStopCommand } from "../../src/commands/team-stop.js";
import { registerTeamAutocomplete } from "../../src/ui/autocomplete.js";
import { buildTeamStatusLine, buildTeamWidgetLines, getTeamStatusTip, hasAnimatedWorkers } from "../../src/ui/status-widget.js";
import { formatRelayToast, formatWorkerLabel, formatWorkerStartedToast, formatWorkerTerminalToast, formatWorkersStartedToast, formatWorkersTerminalToast } from "../../src/ui/display-grammar.js";
import { formatAgentMessageResult, formatAgentResultNotReady, formatDelegateTaskResult, formatWaitForAgentsResult, formatWorkerCompact, formatWorkers } from "../../src/ui/tool-formatters.js";
import { renderAgentToolCallTitle } from "../../src/ui/tool-renderers.js";
import type { NormalizedWorkerEvent } from "../../src/runtime/event-normalizer.js";
import type { WorkerPiVersionMismatchEvent } from "../../src/runtime/worker-manager.js";
import { THINKING_LEVELS, type LoadedTeamProjectConfig, type PersistedTeamState, type TeamConfig, type TeamPersistenceRecord, type ThinkingLevel, type ThinkingLevelConfigWarning, type WorkerRuntimeState } from "../../src/types.js";

const DELEGATE_TASK_MODEL_DESCRIPTION = "Override the worker model (e.g. \"provider/model-id\"). Defaults to the orchestrator's current model.";
const SCOPED_MODEL_PREVIEW_LIMIT = 8;

const DelegateTaskSchema = Type.Object({
	title: Type.String({ description: "Short title for the delegated task" }),
	goal: Type.String({ description: "What the worker should accomplish" }),
	profileName: Type.String({ description: "Worker profile name — see the 'Available worker profiles' block in the system prompt for the live list. Names are user-declared in agents-team.json; don't invent names." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Defaults to the current session cwd." })),
	contextHints: Type.Optional(Type.Array(Type.String(), { description: "Compact context bullets to pass into the worker" })),
	expectedOutput: Type.Optional(Type.String({ description: "Describe the output contract the worker should return" })),
	pathScopeRoots: Type.Optional(Type.Array(Type.String(), { description: "Allowed path roots for scoped workers, especially write-capable profiles." })),
	pathScopeAllowWrite: Type.Optional(Type.Boolean({ description: "Whether the delegated path scope may be written to." })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Optional list of installed Pi skill names to enable on the worker. When set, Pi's skill discovery runs for this worker (normally disabled for worker-minimal launches) and the worker is told to load and apply the requested skills by name. Omit if no specialized skill is needed." })),
	model: Type.Optional(Type.String({ description: DELEGATE_TASK_MODEL_DESCRIPTION })),
	reuseWorkerId: Type.Optional(Type.String({ description: "Reuse an existing idle (or waiting_followup) worker's RPC session for this task instead of spawning a fresh process. Use when the next task is in scope of the previous role and roughly the same path scope — saves spawn cost and keeps warm role context. The worker's prior summary, finalAnswer, and lastTool are reset; a new taskId is allocated. Rejected if the target is running/starting/completed/aborted/error/exited (its RPC is already disposed); cancel + delegate fresh in that case. Check agent_status for `reusable: true` to find candidates." })),
});

const WorkerLookupSchema = Type.Object({
	workerId: Type.Optional(Type.String({ description: "Specific worker id. Omit to inspect all tracked workers." })),
});

const WorkerMessageSchema = Type.Object({
	workerId: Type.String({ description: "Target worker id" }),
	message: Type.String({ description: "Instruction for the worker" }),
	delivery: Type.Optional(
		Type.String({
			description:
				'Delivery mode: "auto" (default), "steer", or "follow_up". Applied only when the worker is running; idle/waiting_followup workers always receive the message as a fresh prompt that wakes the session and starts a new turn.',
		}),
	),
});

const PingAgentsSchema = Type.Object({
	workerIds: Type.Optional(Type.Array(Type.String(), { description: "Worker ids to ping. Omit to ping all workers." })),
	mode: Type.Optional(Type.String({ description: 'Ping mode: "passive" or "active". Active mode refreshes state and stats.' })),
});

const WorkerIdSchema = Type.Object({
	workerId: Type.String({ description: "Target worker id" }),
});

type AgentResultDetails =
	| { workerId: string; status: WorkerRuntimeState["status"]; ready: false }
	| AgentResult;

const WaitForAgentsSchema = Type.Object({
	workerIds: Type.Optional(Type.Array(Type.String(), { description: "Worker ids to wait on. Omit to wait on every tracked worker." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds. Defaults to 300000 (5 min)." })),
	wakeOnRelay: Type.Optional(Type.Boolean({ description: "Return early with reason=relay_raised when any target raises a new relay question. Defaults to true so the orchestrator can answer mid-flight without waiting for every worker to finish." })),
});

type ExtensionAPIWithThinkingLevel = ExtensionAPI & {
	getThinkingLevel?: () => ThinkingLevel;
};

type ExtensionContextWithThinkingLevel = ExtensionContext & {
	getThinkingLevel?: () => ThinkingLevel;
};

type ExtensionContextWithProjectTrust = ExtensionContext & {
	isProjectTrusted?: () => boolean;
};

const SCAFFOLD_FRESHNESS_TOASTS_KEY = Symbol.for("pi-agents-team.scaffoldFreshnessToasts");
const PERSISTENCE_INTEGRITY_BLOCKED_MANAGERS_KEY = Symbol.for("pi-agents-team.persistenceIntegrityBlockedManagers");
const PERSISTENCE_RECORD_WARNING_THRESHOLD = 10_000;
const PERSISTENCE_BYTE_WARNING_THRESHOLD = 64 * 1024 * 1024;
const PERSISTENCE_GROWTH_WARNING = "Pi Agents Team: this active branch contains at least 10,000 compact persistence records or 64 MiB of compact record payloads. Pi sessions are append-only; consider starting a new session. Reload, prune, and branch navigation do not shrink the physical session file. Measured compact payload bytes are not the total session file size.";
const PERSISTENCE_FLUSH_WARNING = "Pi Agents Team: a compact persistence append still failed during final retry; the uncommitted transition could not be saved before teardown.";
const PERSISTENCE_TREE_DROP_WARNING = "Pi Agents Team: compact persistence still failed before tree navigation; unresolved old-branch records were isolated and will not be written onto the new branch.";
const PERSISTENCE_LIVE_WARNING = "Pi Agents Team: a compact persistence append failed; the bounded uncommitted suffix was retained for a later retry.";
const PERSISTENCE_AMBIGUOUS_APPEND_WARNING = "Pi Agents Team: a compact persistence append threw after Pi advanced the session leaf; the durably confirmed tail record was treated as accepted and will not be retried beneath that leaf.";
const PERSISTENCE_AMBIGUOUS_BLOCKED_WARNING = "Pi Agents Team: compact persistence is disabled because this session manager's disk and in-memory state may differ or the session-file boundary could not be captured or restored safely. Restart Pi, reopen the session, or start a new session before retrying persistence; plain /reload is not sufficient.";
const PERSISTENCE_TAIL_READ_BYTES = 32 * 1024;
const PREFERRED_JSON_SCHEMA_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

function createPersistenceGrowthMonitor(notify: (message: string) => void) {
	let measurement: CompactPersistenceMeasurement = { recordCount: 0, payloadBytes: 0 };
	let warningLatched = false;
	let warningEnabled = true;
	const evaluate = () => {
		if (!warningEnabled) {
			warningLatched = false;
			return;
		}
		const aboveThreshold = measurement.recordCount >= PERSISTENCE_RECORD_WARNING_THRESHOLD
			|| measurement.payloadBytes >= PERSISTENCE_BYTE_WARNING_THRESHOLD;
		if (!aboveThreshold) {
			warningLatched = false;
			return;
		}
		if (warningLatched) return;
		warningLatched = true;
		notify(PERSISTENCE_GROWTH_WARNING);
	};
	return {
		replace(next: CompactPersistenceMeasurement, enabled = true): void {
			measurement = { ...next };
			warningEnabled = enabled;
			evaluate();
		},
		recordAppended(payloadBytes: number): void {
			measurement.recordCount += 1;
			measurement.payloadBytes += payloadBytes;
			evaluate();
		},
		snapshot(): CompactPersistenceMeasurement {
			return { ...measurement };
		},
	};
}

function getProcessStableScaffoldFreshnessToasts(): Set<string> {
	const store = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = store[SCAFFOLD_FRESHNESS_TOASTS_KEY];
	if (existing instanceof Set) return existing as Set<string>;

	const freshnessToasts = new Set<string>();
	store[SCAFFOLD_FRESHNESS_TOASTS_KEY] = freshnessToasts;
	return freshnessToasts;
}

function getProcessStablePersistenceIntegrityBlocks(): WeakSet<object> {
	const store = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = store[PERSISTENCE_INTEGRITY_BLOCKED_MANAGERS_KEY];
	if (existing instanceof WeakSet) return existing as WeakSet<object>;

	const blockedManagers = new WeakSet<object>();
	store[PERSISTENCE_INTEGRITY_BLOCKED_MANAGERS_KEY] = blockedManagers;
	return blockedManagers;
}

function getOrchestratorThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): ThinkingLevel | undefined {
	return ctx.thinkingLevel
		?? (pi as ExtensionAPIWithThinkingLevel).getThinkingLevel?.()
		?? (ctx as ExtensionContextWithThinkingLevel).getThinkingLevel?.();
}

function getProjectTrustDecisionForContext(ctx: ExtensionContext): boolean | undefined {
	const isProjectTrusted = (ctx as ExtensionContextWithProjectTrust).isProjectTrusted;
	if (typeof isProjectTrusted !== "function") return undefined;
	return isProjectTrusted.call(ctx) === true;
}

function isProjectConfigTrustedForContext(ctx: ExtensionContext): boolean {
	return getProjectTrustDecisionForContext(ctx) ?? true;
}

function updateDelegateTaskProfileDescription(config: TeamConfig): void {
	const profileListSnapshot = config.profiles.map((profile) => profile.name);
	const profileListSummary = profileListSnapshot.length > 0 ? profileListSnapshot.join(", ") : "(none declared)";
	(DelegateTaskSchema.properties.profileName as { description?: string }).description =
		`Worker profile name. Currently declared in this session: ${profileListSummary}. See the 'Available worker profiles' block in the orchestrator system prompt for details and write policy. Don't invent names that aren't in that list — delegate_task will fail.`;
}

function buildDelegateTaskModelDescription(scopedModels: unknown): string {
	if (!Array.isArray(scopedModels) || scopedModels.length === 0) return DELEGATE_TASK_MODEL_DESCRIPTION;

	const modelRefs: string[] = [];
	const seen = new Set<string>();
	for (const entry of scopedModels) {
		if (!entry || typeof entry !== "object") continue;
		const model = (entry as { model?: unknown }).model;
		if (!model || typeof model !== "object") continue;
		const provider = typeof (model as { provider?: unknown }).provider === "string"
			? (model as { provider: string }).provider.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 96)
			: "";
		const id = typeof (model as { id?: unknown }).id === "string"
			? (model as { id: string }).id.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160)
			: "";
		if (!provider || !id) continue;
		const modelRef = `${provider}/${id}`;
		if (seen.has(modelRef)) continue;
		seen.add(modelRef);
		modelRefs.push(modelRef);
	}
	if (modelRefs.length === 0) return DELEGATE_TASK_MODEL_DESCRIPTION;

	const preview = modelRefs.slice(0, SCOPED_MODEL_PREVIEW_LIMIT).join(", ");
	const remaining = modelRefs.length - SCOPED_MODEL_PREVIEW_LIMIT;
	const overflow = remaining > 0 ? ` (+${remaining} more)` : "";
	return `${DELEGATE_TASK_MODEL_DESCRIPTION} Models suggested by the orchestrator's current Pi scope: ${preview}${overflow}. This list is advisory; role-specific config and worker extensions may make additional model IDs available.`;
}

function updateDelegateTaskModelDescription(scopedModels: unknown): void {
	(DelegateTaskSchema.properties.model as { description?: string }).description =
		buildDelegateTaskModelDescription(scopedModels);
}

function isPersistedSession(ctx: ExtensionContext): boolean {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { isPersisted?: () => boolean };
	return typeof sessionManager.isPersisted !== "function" || sessionManager.isPersisted() !== false;
}

interface PersistenceSessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	customType?: string;
	data?: unknown;
}


interface SessionFileBoundary {
	path: string;
	existed: boolean;
	size: number;
}

function captureSessionFileBoundary(sessionFile: string | undefined): SessionFileBoundary | undefined {
	if (!sessionFile) return undefined;
	try {
		return { path: sessionFile, existed: true, size: statSync(sessionFile).size };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { path: sessionFile, existed: false, size: 0 };
		}
		return undefined;
	}
}

function restoreSessionFileBoundary(boundary: SessionFileBoundary | undefined): boolean {
	if (!boundary) return false;
	try {
		if (boundary.existed) {
			truncateSync(boundary.path, boundary.size);
			return statSync(boundary.path).size === boundary.size;
		}
		if (existsSync(boundary.path)) unlinkSync(boundary.path);
		return !existsSync(boundary.path);
	} catch {
		return false;
	}
}

function persistedTailContainsRecord(
	sessionFile: string,
	leafId: string,
	stateCustomType: string,
	recordId: string,
): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(sessionFile, "r");
		const size = fstatSync(descriptor).size;
		if (size <= 0) return false;
		const length = Math.min(size, PERSISTENCE_TAIL_READ_BYTES);
		const buffer = Buffer.allocUnsafe(length);
		const bytesRead = readSync(descriptor, buffer, 0, length, size - length);
		const rawTail = buffer.subarray(0, bytesRead).toString("utf8").trimEnd().split("\n").at(-1);
		if (!rawTail) return false;
		const tail: unknown = JSON.parse(rawTail);
		if (!tail || typeof tail !== "object" || Array.isArray(tail)) return false;
		if (!("id" in tail) || tail.id !== leafId
			|| !("type" in tail) || tail.type !== "custom"
			|| !("customType" in tail) || tail.customType !== stateCustomType
			|| !("data" in tail) || !tail.data || typeof tail.data !== "object" || Array.isArray(tail.data)
			|| !("recordId" in tail.data)) return false;
		return tail.data.recordId === recordId;
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// A completed read remains usable; descriptor cleanup cannot change
				// whether the exact record was already present at the file tail.
			}
		}
	}
}

function restoreLatestState(
	ctx: ExtensionContext,
	startReason: "startup" | "reload" | "new" | "resume" | "fork",
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): { state: PersistedTeamState; markedCount: number; persistenceMeasurement: CompactPersistenceMeasurement } {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		getBranch?: () => Iterable<PersistenceSessionEntry>;
	};
	const branch = sessionManager.getBranch?.() ?? [];
	const restored = restorePersistedTeamStateWithMeasurement(branch, config.persistence.stateCustomType);
	const { state, markedCount } = markRestoredWorkersExited(restored.state, startReason);
	return { state, markedCount, persistenceMeasurement: restored.measurement };
}

function applyUi(
	ctx: ExtensionContext | undefined,
	state: PersistedTeamState,
	frame = 0,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
	active = true,
	routingMode: "team" | "solo" = "team",
	displayCost = true,
	tip?: string,
	orchestratorWorking = false,
): void {
	if (!ctx?.hasUI) return;
	if (!active) {
		ctx.ui.setStatus(config.ui.statusKey, undefined);
		ctx.ui.setWidget(config.ui.widgetKey, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const widgetLines = buildTeamWidgetLines(state, { frame, routingMode, displayCost, theme, width: 80 });
	ctx.ui.setStatus(config.ui.statusKey, buildTeamStatusLine(state, routingMode, tip, orchestratorWorking, theme));
	if (widgetLines.length === 0) {
		ctx.ui.setWidget(config.ui.widgetKey, undefined);
	} else if (ctx.mode === "tui") {
		ctx.ui.setWidget(
			config.ui.widgetKey,
			(_tui, widgetTheme) => ({
				render: (width) => buildTeamWidgetLines(state, { frame, routingMode, displayCost, theme: widgetTheme, width }),
				invalidate: () => {},
			}),
		);
	} else {
		ctx.ui.setWidget(
			config.ui.widgetKey,
			widgetLines,
		);
	}
	ctx.ui.setTitle(config.ui.titleTemplate.replace("{mode}", state.sessionMode));
}

function clearUi(ctx: ExtensionContext | undefined, config: TeamConfig = DEFAULT_TEAM_CONFIG): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(config.ui.statusKey, undefined);
	ctx.ui.setWidget(config.ui.widgetKey, undefined);
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
	const pathSuffix = path ? ` (source: ${path})` : "";
	return `Pi Agents Team is disabled${pathSuffix}. Enable it by editing agents-team.json (set enabled: true), then /reload.`;
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

function formatScopeLabel(scope: string): string {
	return scope === "project" ? "local" : scope;
}

function formatConfigValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function thinkingLevelWarningToastKey(warning: ThinkingLevelConfigWarning): string {
	return `${warning.scope}\0${warning.profileName}\0${formatConfigValue(warning.badValue)}`;
}

function buildThinkingLevelWarningToast(warning: ThinkingLevelConfigWarning): string {
	const scopeLabel = formatScopeLabel(warning.scope);
	return `Pi Agents Team: ${scopeLabel} agents-team.json role "${warning.profileName}" has invalid thinkingLevel "${formatConfigValue(warning.badValue)}"; field dropped and default thinkingLevel will be used. Valid values: ${THINKING_LEVELS.join(", ")}.`;
}

function thinkingClampToastKey(event: Extract<NormalizedWorkerEvent, { type: "thinking_clamped" }>): string {
	return `${event.workerId}\0${event.requested}\0${event.effective}`;
}

function buildThinkingClampToast(event: Extract<NormalizedWorkerEvent, { type: "thinking_clamped" }>): string {
	const modelPart = event.modelLabel ? ` for model ${event.modelLabel}` : "";
	return `Pi Agents Team: worker ${event.workerId} (${event.profileName}) requested thinkingLevel ${event.requested}; Pi clamped to ${event.effective}${modelPart} because the model lacks support. Edit agents-team.json or change model.`;
}

function buildPiVersionMismatchToast(event: WorkerPiVersionMismatchEvent): string {
	return event.message;
}

function emitPiVersionMismatchWarning(ctx: ExtensionContext | undefined, message: string): void {
	if (ctx?.hasUI) {
		ctx.ui.notify(message, "warning");
		return;
	}
	console.error(message);
}

function createPiVersionMismatchNotifier(notify: (message: string) => void): {
	notify(event: WorkerPiVersionMismatchEvent): void;
	reset(): void;
} {
	let warned = false;
	return {
		notify(event) {
			if (warned) return;
			warned = true;
			notify(buildPiVersionMismatchToast(event));
		},
		reset() {
			warned = false;
		},
	};
}

export const _testing = {
	createPersistenceGrowthMonitor,
	PERSISTENCE_BYTE_WARNING_THRESHOLD,
	PERSISTENCE_GROWTH_WARNING,
	PERSISTENCE_RECORD_WARNING_THRESHOLD,
	buildPiVersionMismatchToast,
	createPiVersionMismatchNotifier,
	emitPiVersionMismatchWarning,
	buildThinkingClampToast,
	buildThinkingLevelWarningToast,
	getOrchestratorThinkingLevel,
	buildDelegateTaskModelDescription,
	getProjectTrustDecisionForContext,
	isProjectConfigTrustedForContext,
	thinkingClampToastKey,
	thinkingLevelWarningToastKey,
};

export default function (pi: ExtensionAPI): void {
	let activeProjectConfig = loadActiveTeamConfig({
		cwd: process.cwd(),
		baseConfig: DEFAULT_TEAM_CONFIG,
		projectConfigTrusted: false,
	});

	// Mutate the profileName description to surface the current role list right
	// in the tool schema. Pi's ToolDefinition.parameters is frozen at
	// registerTool time with no dynamic-enum seam, but the `description` string
	// is read by the orchestrator LLM every turn; seeding it here gives the
	// model a schema-level hint of which names are valid. On session_start and
	// /reload the active config may change, so refresh it after trust-aware load.
	updateDelegateTaskProfileDescription(activeProjectConfig.config);
	updateDelegateTaskModelDescription(undefined);

	const deriveInitialRoutingMode = (loaded: LoadedTeamProjectConfig): "team" | "solo" => {
		if (!loaded.enabled || !loaded.delegationEnabled) return "solo";
		return loaded.persistedRoutingMode ?? "team";
	};

	let teamManager = new TeamManager({
		config: activeProjectConfig.config,
		routingMode: deriveInitialRoutingMode(activeProjectConfig),
		displayCost: activeProjectConfig.displayCost,
	});
	let teamState = createDefaultTeamState(activeProjectConfig.config);
	let activeContext: ExtensionContext | undefined;
	let detachTeamManagerListener = (_flushPersistence?: boolean) => {};
	const persistenceJournal = new CompactPersistenceJournal();
	const persistenceGrowth = createPersistenceGrowthMonitor((message) => {
		if (activeContext?.hasUI) activeContext.ui.notify(message, "warning");
		else console.error(message);
	});
	const persistenceFailureWarnings = new Set<string>();
	type ProvisionalTreeNavigation = {
		originLeafId: string | null;
		appendLeafId: string | null;
		confirmed: boolean;
		rootDispatchBlocked: boolean;
		originBranchEntryIds: ReadonlySet<string>;
		preexistingEntryIds: ReadonlySet<string>;
	};
	let provisionalTreeNavigation: ProvisionalTreeNavigation | undefined;
	// Pi /reload rebuilds this factory but retains the SessionManager. Keep the
	// fail-closed latch process-stable and identity-scoped; WeakSet GC naturally
	// releases it once a genuinely replaced/reopened manager becomes unreachable.
	const persistenceIntegrityBlockedManagers = getProcessStablePersistenceIntegrityBlocks();
	const restoredWorkerIds = new Set<string>();
	// Gate for session_start swap window — tool bodies reject during reload so
	// an in-flight delegate_task / wait_for_agents / agent_message doesn't
	// resolve against a disposed TeamManager.
	let reloading = false;
	// De-dup active config scaffold freshness toasts across session_start
	// events. Pi fires session_start on startup, reload, new, resume, fork;
	// without de-dup, operators iterating with /reload see the same warning
	// every time. We emit once per active (scope, scaffoldVersion) or unknown
	// scaffold state per process.
	const toastedScaffoldStale = getProcessStableScaffoldFreshnessToasts();
	const toastedThinkingLevelWarnings = new Map<string, true>();
	const toastedThinkingClamps = new Map<string, true>();
	const piVersionMismatchNotifier = createPiVersionMismatchNotifier((message) => {
		emitPiVersionMismatchWarning(activeContext, message);
	});
	const lastStatus = new Map<string, WorkerRuntimeState["status"]>();
	const lastRelayCount = new Map<string, number>();
	const pendingStartedTransitions: Array<{ workerId: string; profileName: string }> = [];
	const pendingTerminalTransitions: Array<{ workerId: string; profileName: string; status: WorkerRuntimeState["status"] }> = [];
	let notificationTimer: NodeJS.Timeout | undefined;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let tipTimer: NodeJS.Timeout | undefined;
	let spinnerFrame = 0;
	let tipIndex = 0;
	let orchestratorWorking = false;
	const SPINNER_INTERVAL_MS = 120;
	const TIP_INTERVAL_MS = 15_000;

	function renderUi(
		ctx: ExtensionContext | undefined,
		state: PersistedTeamState,
		frame = spinnerFrame,
		config: TeamConfig = activeProjectConfig.config,
		active = isTeamActive(activeProjectConfig),
		routingMode: "team" | "solo" = teamManager.routingMode,
		displayCost = activeProjectConfig.displayCost,
	): void {
		applyUi(ctx, state, frame, config, active, routingMode, displayCost, getTeamStatusTip(tipIndex), orchestratorWorking);
		if (ctx?.hasUI && active) ensureTipRotationRunning();
		else stopTipRotation();
	}

	function ensureSpinnerRunning(): void {
		if (spinnerTimer || !activeContext?.hasUI) return;
		if (!hasAnimatedWorkers(teamState)) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % 10;
			if (!activeContext?.hasUI || !hasAnimatedWorkers(teamState)) {
				stopSpinner();
				return;
			}
			renderUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
		}, SPINNER_INTERVAL_MS);
		if (typeof spinnerTimer.unref === "function") spinnerTimer.unref();
	}

	function stopSpinner(): void {
		if (!spinnerTimer) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}

	function ensureTipRotationRunning(): void {
		if (tipTimer || !activeContext?.hasUI || !isTeamActive(activeProjectConfig)) return;
		tipTimer = setInterval(() => {
			if (!activeContext?.hasUI || !isTeamActive(activeProjectConfig)) {
				stopTipRotation();
				return;
			}
			tipIndex += 1;
			renderUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, true, teamManager.routingMode, activeProjectConfig.displayCost);
		}, TIP_INTERVAL_MS);
		if (typeof tipTimer.unref === "function") tipTimer.unref();
	}

	function stopTipRotation(): void {
		if (!tipTimer) return;
		clearInterval(tipTimer);
		tipTimer = undefined;
	}

	function resetUiTracking(): void {
		lastStatus.clear();
		lastRelayCount.clear();
		pendingStartedTransitions.length = 0;
		pendingTerminalTransitions.length = 0;
		if (notificationTimer) {
			clearTimeout(notificationTimer);
			notificationTimer = undefined;
		}
	}

	function flushWorkerNotifications(): void {
		notificationTimer = undefined;
		const started = pendingStartedTransitions.splice(0);
		const terminal = pendingTerminalTransitions.splice(0);
		if (!activeContext?.hasUI) return;

		const startedItems = started.filter((item) => {
			const current = lastStatus.get(item.workerId);
			return current === "starting" || current === "running";
		});
		if (startedItems.length === 1) {
			activeContext.ui.notify(formatWorkerStartedToast(startedItems[0]), "info");
		} else if (startedItems.length > 1) {
			activeContext.ui.notify(formatWorkersStartedToast(startedItems), "info");
		}

		const terminalItems = terminal.filter((item) => {
			const current = lastStatus.get(item.workerId);
			return current ? isTerminalWorkerStatus(current) : false;
		});
		if (terminalItems.length === 1) {
			activeContext.ui.notify(formatWorkerTerminalToast(terminalItems[0]), "info");
		} else if (terminalItems.length > 1) {
			activeContext.ui.notify(formatWorkersTerminalToast(terminalItems), "info");
		}
	}

	function notifyThinkingLevelWarnings(ctx: ExtensionContext, warnings: ThinkingLevelConfigWarning[] | undefined): void {
		if (!ctx.hasUI || !warnings?.length) return;
		for (const warning of warnings) {
			const dedupKey = thinkingLevelWarningToastKey(warning);
			if (toastedThinkingLevelWarnings.has(dedupKey)) continue;
			toastedThinkingLevelWarnings.set(dedupKey, true);
			ctx.ui.notify(buildThinkingLevelWarningToast(warning), "warning");
		}
	}

	function notifyActiveConfigFreshness(ctx: ExtensionContext, loaded: LoadedTeamProjectConfig): void {
		if (!ctx.hasUI) return;
		const freshness = loaded.activeConfigFreshness;
		if (freshness.kind === "none" || freshness.parseStatus !== "valid") return;
		const scopeLabel = freshness.scope === "project" ? "local" : "global";
		const initScope = scopeLabel;
		if (freshness.scaffoldVersionMissing) {
			const dedupKey = `${freshness.scope}\0unknown`;
			if (toastedScaffoldStale.has(dedupKey)) return;
			toastedScaffoldStale.add(dedupKey);
			ctx.ui.notify(
				`Pi Agents Team: active ${scopeLabel} agents-team.json has no scaffoldVersion; plugin is ${CURRENT_SCAFFOLD_VERSION} and cannot verify scaffold freshness. Run /team-init ${initScope} --force to refresh if this file predates scaffoldVersion tracking (old file is backed up first).`,
				"warning",
			);
			return;
		}
		if (!freshness.scaffoldStale || freshness.scaffoldVersion === undefined) return;
		const dedupKey = `${freshness.scope}\0${freshness.scaffoldVersion}`;
		if (toastedScaffoldStale.has(dedupKey)) return;
		toastedScaffoldStale.add(dedupKey);
		ctx.ui.notify(
			`Pi Agents Team: active ${scopeLabel} agents-team.json is scaffoldVersion ${freshness.scaffoldVersion}, plugin is ${CURRENT_SCAFFOLD_VERSION}. Run /team-init ${initScope} --force to refresh (old file is backed up first).`,
			"warning",
		);
	}

	function notifyThinkingClamp(event: Extract<NormalizedWorkerEvent, { type: "thinking_clamped" }>): void {
		if (!activeContext?.hasUI) return;
		const dedupKey = thinkingClampToastKey(event);
		if (toastedThinkingClamps.has(dedupKey)) return;
		toastedThinkingClamps.set(dedupKey, true);
		activeContext.ui.notify(buildThinkingClampToast(event), "warning");
	}

	function notifyPiVersionMismatch(event: WorkerPiVersionMismatchEvent): void {
		piVersionMismatchNotifier.notify(event);
	}

	function currentSessionManager(): {
		getLeafId?: () => string | null;
		getBranch?: () => Iterable<{ id?: string }>;
		getEntries?: () => Iterable<{ id?: string }>;
		getEntry?: (id: string) => {
			id?: string;
			parentId?: string | null;
			type?: string;
			customType?: string;
			targetId?: string;
			data?: unknown;
		} | undefined;
		isPersisted?: () => boolean;
		getSessionFile?: () => string | undefined;
		branch?: (id: string) => void;
		resetLeaf?: () => void;
	} | undefined {
		return activeContext?.sessionManager as {
			getLeafId?: () => string | null;
			getBranch?: () => Iterable<{ id?: string }>;
			getEntries?: () => Iterable<{ id?: string }>;
			getEntry?: (id: string) => {
				id?: string;
				parentId?: string | null;
				type?: string;
				customType?: string;
				targetId?: string;
				data?: unknown;
			} | undefined;
			isPersisted?: () => boolean;
			getSessionFile?: () => string | undefined;
			branch?: (id: string) => void;
			resetLeaf?: () => void;
		} | undefined;
	}

	function currentLeafId(): string | null | undefined {
		return currentSessionManager()?.getLeafId?.();
	}

	function assertPersistenceAppendStillOnOriginBranch(): void {
		const navigation = provisionalTreeNavigation;
		if (!navigation) return;
		const sessionManager = currentSessionManager();
		const leafId = sessionManager?.getLeafId?.();
		if (leafId === undefined) return;
		if (navigation.rootDispatchBlocked && !navigation.confirmed && navigation.originLeafId === null) {
			throw new Error("Refusing to append root-origin persistence before tree navigation is confirmed or cancelled.");
		}
		if (leafId === navigation.appendLeafId) return;
		if (navigation.appendLeafId === null && !navigation.confirmed) {
			const branch = Array.from(sessionManager?.getBranch?.() ?? []);
			const reachedPreexistingDestination = branch.some((entry) =>
				typeof entry.id === "string"
				&& navigation.preexistingEntryIds.has(entry.id)
				&& !navigation.originBranchEntryIds.has(entry.id));
			const leafEntry = leafId === null ? undefined : sessionManager?.getEntry?.(leafId);
			const reachedNavigationArtifact = leafEntry?.type === "branch_summary"
				|| (leafEntry?.type === "label"
					&& typeof leafEntry.targetId === "string"
					&& navigation.preexistingEntryIds.has(leafEntry.targetId));
			if (!reachedPreexistingDestination && !reachedNavigationArtifact) return;
		}
		if (navigation.appendLeafId !== null) {
			const branch = sessionManager?.getBranch?.();
			if (branch && Array.from(branch).some((entry) => entry.id === navigation.appendLeafId)) return;
		}
		throw new Error("Refusing to append an old-branch compact persistence record after the active branch changed.");
	}

	function observePersistenceAppendLeaf(): void {
		const navigation = provisionalTreeNavigation;
		if (!navigation) return;
		const leafId = currentLeafId();
		if (leafId !== undefined) navigation.appendLeafId = leafId;
	}

	function appendPreparedPersistence(maxBatches = 2, initialRecords?: readonly TeamPersistenceRecord[]): boolean {
		const sessionManagerAtStart = currentSessionManager();
		if (sessionManagerAtStart && persistenceIntegrityBlockedManagers.has(sessionManagerAtStart)) {
			warnPersistenceFailure(PERSISTENCE_AMBIGUOUS_BLOCKED_WARNING);
			return false;
		}

		for (let batch = 0; batch < maxBatches; batch += 1) {
			const records = batch === 0 && initialRecords
				? initialRecords
				: persistenceJournal.prepare(teamState, activeProjectConfig.config);
			if (records.length === 0) return true;
			for (const record of records) {
				const leafBeforeAppend = currentLeafId();
				const sessionManagerBeforeAppend = currentSessionManager();
				const explicitlyPersisted = sessionManagerBeforeAppend?.isPersisted?.() === true;
				const sessionFileBeforeAppend = explicitlyPersisted
					? sessionManagerBeforeAppend.getSessionFile?.()
					: undefined;
				const fileBoundary = captureSessionFileBoundary(sessionFileBeforeAppend);
				if (explicitlyPersisted && (!sessionFileBeforeAppend || !fileBoundary)) {
					persistenceIntegrityBlockedManagers.add(sessionManagerBeforeAppend);
					warnPersistenceFailure(PERSISTENCE_AMBIGUOUS_BLOCKED_WARNING);
					return false;
				}
				try {
					// Keep this guard adjacent to appendEntry: prepare may have run while an
					// asynchronous tree summary was still moving the active leaf.
					assertPersistenceAppendStillOnOriginBranch();
					pi.appendEntry(activeProjectConfig.config.persistence.stateCustomType, record);
				} catch {
					const sessionManager = currentSessionManager();
					const leafAfterFailure = sessionManager?.getLeafId?.();
					const advancedLeafId = typeof leafAfterFailure === "string" ? leafAfterFailure : undefined;
					const leafEntry = advancedLeafId ? sessionManager?.getEntry?.(advancedLeafId) : undefined;
					const entryData = leafEntry?.data;
					const entryRecordId = entryData && typeof entryData === "object" && "recordId" in entryData
						? entryData.recordId
						: undefined;
					const advancedToAttemptedRecord = leafBeforeAppend !== undefined
						&& advancedLeafId !== undefined
						&& advancedLeafId !== leafBeforeAppend
						&& leafEntry?.type === "custom"
						&& leafEntry.customType === activeProjectConfig.config.persistence.stateCustomType
						&& entryRecordId === record.recordId;
					if (!advancedToAttemptedRecord || advancedLeafId === undefined) return false;

					const persisted = sessionManager?.isPersisted?.() !== false;
					const sessionFile = sessionManager?.getSessionFile?.();
					const durablyConfirmed = !persisted
						|| (typeof sessionFile === "string"
							&& persistedTailContainsRecord(
								sessionFile,
								advancedLeafId,
								activeProjectConfig.config.persistence.stateCustomType,
								record.recordId,
							));
					if (!durablyConfirmed) {
						// Truncating the partial write cannot remove the attempted entry from
						// SessionManager's private index. Move its leaf back when possible so
						// ordinary session writes remain rooted at a durable parent, but fail
						// closed: only a clean reload can make memory match disk again.
						restoreSessionFileBoundary(fileBoundary);
						try {
							if (leafBeforeAppend === null) sessionManager?.resetLeaf?.();
							else sessionManager?.branch?.(leafBeforeAppend);
						} catch {
							// The integrity block below is required regardless of leaf repair.
						}
						if (sessionManager) persistenceIntegrityBlockedManagers.add(sessionManager);
						else if (sessionManagerBeforeAppend) persistenceIntegrityBlockedManagers.add(sessionManagerBeforeAppend);
						warnPersistenceFailure(PERSISTENCE_AMBIGUOUS_BLOCKED_WARNING);
						return false;
					}

					// Pi 0.80.6/0.80.7 update SessionManager's leaf before synchronous
					// persistence and extension emission complete. Commit only when the
					// exact in-memory entry is also the durable file tail.
					observePersistenceAppendLeaf();
					persistenceJournal.resolveAmbiguousAppend(record);
					persistenceGrowth.recordAppended(compactPersistenceRecordPayloadBytes(record));
					warnPersistenceFailure(PERSISTENCE_AMBIGUOUS_APPEND_WARNING);
					continue;
				}
				observePersistenceAppendLeaf();
				persistenceJournal.commit(record);
				persistenceGrowth.recordAppended(compactPersistenceRecordPayloadBytes(record));
			}
		}
		return !persistenceJournal.hasPending();
	}

	function warnPersistenceFailure(message: string): void {
		if (persistenceFailureWarnings.has(message)) return;
		persistenceFailureWarnings.add(message);
		if (activeContext?.hasUI) activeContext.ui.notify(message, "warning");
		else console.error(message);
	}

	function attemptBoundedPersistenceFlush(): boolean {
		try {
			// Finite invariant: one retained suffix plus one batch derived from the
			// latest state. A persistent failure is attempted only once per flush.
			return appendPreparedPersistence(2);
		} catch {
			return false;
		}
	}

	function flushPendingPersistence(): void {
		if (!attemptBoundedPersistenceFlush()) warnPersistenceFailure(PERSISTENCE_FLUSH_WARNING);
	}

	function attachTeamManagerListener(manager: TeamManager): void {
		detachTeamManagerListener();
		resetUiTracking();
		const detachBeforePromptListener = manager.onBeforePrompt((state) => {
			teamState = state;
			const checkpointRecords = persistenceJournal.prepareDetachedWorkers(teamState, activeProjectConfig.config);
			if (!appendPreparedPersistence(1, checkpointRecords)) {
				warnPersistenceFailure(PERSISTENCE_LIVE_WARNING);
				throw new Error("Worker prompt was not sent because its durable persistence checkpoint could not be appended.");
			}
		});
		const detachStateListener = manager.onStateChange((state) => {
			teamState = state;
			// Persistence is best-effort at this callback boundary. Pi invokes state
			// listeners inside successful RPC lifecycle transitions, so append I/O
			// must never escape and relabel a settled worker as worker_error.
			if (!attemptBoundedPersistenceFlush()) warnPersistenceFailure(PERSISTENCE_LIVE_WARNING);
			renderUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);

			if (hasAnimatedWorkers(teamState)) {
				ensureSpinnerRunning();
			} else {
				stopSpinner();
			}

			for (const worker of Object.values(state.activeWorkers)) {
				const previous = lastStatus.get(worker.workerId);
				const nowTerminal = isTerminalWorkerStatus(worker.status);
				const wasTerminal = previous ? isTerminalWorkerStatus(previous) : false;
				if (!previous && (worker.status === "starting" || worker.status === "running")) {
					pendingStartedTransitions.push({
						workerId: worker.workerId,
						profileName: worker.profileName,
					});
					if (notificationTimer) clearTimeout(notificationTimer);
					notificationTimer = setTimeout(flushWorkerNotifications, 400);
				}
				if (previous !== worker.status && nowTerminal && !wasTerminal) {
					pendingTerminalTransitions.push({
						workerId: worker.workerId,
						profileName: worker.profileName,
						status: worker.status,
					});
					if (notificationTimer) clearTimeout(notificationTimer);
					notificationTimer = setTimeout(flushWorkerNotifications, 400);
				}
				lastStatus.set(worker.workerId, worker.status);

				const prevRelays = lastRelayCount.get(worker.workerId) ?? 0;
				const currRelays = worker.pendingRelayQuestions.length;
				if (currRelays > prevRelays && activeContext?.hasUI) {
					const newest = worker.pendingRelayQuestions[worker.pendingRelayQuestions.length - 1];
					const question = newest?.question?.trim();
					if (question) {
						activeContext.ui.notify(formatRelayToast(worker, question), "warning");
					}
				}
				lastRelayCount.set(worker.workerId, currRelays);
			}
		});
		const workerEvents = (manager as unknown as {
			workerManager?: {
				onEvent(listener: (_worker: unknown, event: NormalizedWorkerEvent) => void): () => void;
				onPiVersionMismatch(listener: (event: WorkerPiVersionMismatchEvent) => void): () => void;
			};
		}).workerManager;
		const detachWorkerEventListener = workerEvents?.onEvent((_worker, event) => {
			if (event.type === "thinking_clamped") {
				notifyThinkingClamp(event);
			}
		}) ?? (() => {});
		const detachVersionMismatchListener = workerEvents?.onPiVersionMismatch(notifyPiVersionMismatch) ?? (() => {});
		let detached = false;
		detachTeamManagerListener = (flushPersistence = true) => {
			if (detached) return;
			detached = true;
			// session_tree confirms Pi already changed leaves. The handler isolates
			// old pending data before replacement, and this old listener must not
			// derive or append another old-branch candidate at the new leaf.
			if (flushPersistence && !provisionalTreeNavigation?.confirmed) flushPendingPersistence();
			detachBeforePromptListener();
			detachStateListener();
			detachWorkerEventListener();
			detachVersionMismatchListener();
		};
	}

	async function replaceTeamManager(config: TeamConfig): Promise<void> {
		detachTeamManagerListener();
		await teamManager.dispose();
		teamManager = new TeamManager({ config, routingMode: deriveInitialRoutingMode(activeProjectConfig), displayCost: activeProjectConfig.displayCost });
		attachTeamManagerListener(teamManager);
		teamState = createDefaultTeamState(config);
		renderUi(activeContext, teamState, spinnerFrame, config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
	}

	attachTeamManagerListener(teamManager);

	const commandDependencies = {
		get teamManager() {
			return teamManager;
		},
		emitText: (ctx: ExtensionContext, text: string) => emitCommandOutput(pi, ctx, text, activeProjectConfig.config),
	};
	registerTeamCommand(pi, commandDependencies);
	registerCopyCommand(pi, commandDependencies);
	registerTeamInitCommand(pi, { emitText: commandDependencies.emitText });
	registerTeamEnableCommand(pi, {
		getTeamManager: () => teamManager,
		getProjectConfig: () => activeProjectConfig,
		emitText: commandDependencies.emitText,
		ensureNotReloading,
	});
	registerTeamResultCommand(pi, commandDependencies);
	registerTeamSteerCommand(pi, commandDependencies);
	registerTeamStopCommand(pi, commandDependencies);

	function ensureNotReloading(): void {
		if (reloading) {
			throw new Error("Pi Agents Team is reloading its project config — retry in a moment.");
		}
	}

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Launch a background Pi RPC worker for a bounded delegated task and track it in the orchestrator state.",
		parameters: DelegateTaskSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("delegate_task"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ensureNotReloading();
			if (!activeProjectConfig.enabled) {
				throw new Error(getDisabledMessage(activeProjectConfig));
			}
			if (!activeProjectConfig.delegationEnabled) {
				throw new Error(getDelegationDisabledMessage(activeProjectConfig));
			}
			if (teamManager.routingMode === "solo") {
				throw new Error("Team routing off. Run /team-enable on to delegate.");
			}
			const pathScope = params.pathScopeRoots?.length
				? {
					roots: params.pathScopeRoots,
					allowReadOutsideRoots: false,
					allowWrite: params.pathScopeAllowWrite === true,
				}
				: undefined;
			const orchestratorModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const orchestratorThinkingLevel = getOrchestratorThinkingLevel(pi, ctx);
			const projectTrusted = getProjectTrustDecisionForContext(ctx);
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
				orchestratorThinkingLevel,
				projectTrusted,
				projectTrustRoot: projectTrusted === undefined ? undefined : activeProjectConfig.projectRoot ?? ctx.cwd,
				reuseWorkerId: params.reuseWorkerId,
			}, signal);
			teamState = teamManager.snapshot();
			renderUi(activeContext, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
			return {
				content: [
					{
						type: "text",
						text: formatDelegateTaskResult({ ...result, reuseWorkerId: params.reuseWorkerId }),
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Return compact status for one worker or all tracked workers. Done statuses are idle/completed/aborted/error/exited; starting/running/waiting_followup are not done. Each worker carries `reusable: true` when its RPC session is still alive (idle or waiting_followup) — pass that workerId as delegate_task.reuseWorkerId to skip spawning a fresh process. For the worker's actual output, call agent_result.",
		parameters: WorkerLookupSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("agent_status"),
		async execute(_toolCallId, params) {
			const resolvedId = params.workerId ? teamManager.resolveWorkerId(params.workerId) ?? params.workerId : undefined;
			const workers = resolvedId
				? [teamManager.getWorkerStatus(resolvedId)].filter((worker): worker is WorkerRuntimeState => Boolean(worker))
				: teamManager.listWorkers();
			const decorated = workers.map((worker) => ({
				...worker,
				reusable: worker.status === "idle" || worker.status === "waiting_followup",
			}));
			return {
				content: [{ type: "text", text: formatWorkers(workers) }],
				details: { workers: decorated },
			};
		},
	});

	pi.registerTool<typeof WorkerIdSchema, AgentResultDetails>({
		name: "agent_result",
		label: "Agent Result",
		description: "Get a terminal worker's final deliverable as compact plain text: worker title, optional task/status/error/relay lines, scan-friendly summary sections when available, then Result: followed by the verbatim contents of the worker's <final_answer>…</final_answer> block. Results remain unavailable until agent settlement; wait_for_agents before retrying. Terminal error/aborted/exited workers remain readable. This is the authoritative answer — synthesize directly from it. If the final_answer block is missing after settlement, steer or re-delegate with a clearer final_answer instruction instead of reading files yourself.",
		parameters: WorkerIdSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("agent_result"),
		async execute(_toolCallId, params) {
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = teamManager.getWorkerResult(workerId);
			if (!result) {
				throw new Error(`Unknown worker: ${params.workerId}`);
			}
			if (!isTerminalWorkerStatus(result.worker.status)) {
				return {
					content: [{ type: "text", text: formatAgentResultNotReady(result.worker) }],
					details: {
						workerId: result.worker.workerId,
						status: result.worker.status,
						ready: false,
					},
				};
			}
			const compactResult = formatWorkerCompact(result.worker);
			const restoredResultNote = !result.worker.finalAnswer?.trim() && restoredWorkerIds.has(result.worker.workerId)
				? "\n\nResult note: Full final answers are live-session-only and are unavailable after session restore; use the retained summary and usage above."
				: "";
			return {
				content: [{ type: "text", text: compactResult + restoredResultNote }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "agent_message",
		label: "Agent Message",
		description:
			"Send a message to a tracked worker. Running workers receive it as a mid-stream steer (or a follow_up queued onto the live stream when delivery=follow_up). Idle/waiting_followup workers wake up and start a new turn with the message as the next user prompt; completed/aborted/error/exited workers cannot receive messages.",
		parameters: WorkerMessageSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("agent_message"),
		async execute(_toolCallId, params) {
			ensureNotReloading();
			const delivery = params.delivery === "steer" || params.delivery === "follow_up" ? params.delivery : "auto";
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = await teamManager.messageWorker(workerId, params.message, delivery);
			return {
				content: [{ type: "text", text: formatAgentMessageResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ping_agents",
		label: "Ping Agents",
		description: "Return passive or active status for tracked workers. Active mode refreshes attached live workers and returns registry snapshots for restored/disposed workers. Prefer wait_for_agents while waiting. Done statuses are idle/completed/aborted/error/exited; running means not done.",
		parameters: PingAgentsSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("ping_agents"),
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
		description: "Block until every target worker reaches a terminal status (idle, completed, aborted, error, exited) or until a target raises a new relay question. Also honors a timeout. Returns reason=all_terminal, relay_raised (with newRelays listed), timeout, aborted, or wrapper-only no_workers when no targets are tracked. Prefer this over repeated ping_agents polling — it consumes no tokens while waiting. Use it after delegate_task; when it returns relay_raised, answer via agent_message and call wait_for_agents again to resume.",
		parameters: WaitForAgentsSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("wait_for_agents"),
		async execute(_toolCallId, params, signal) {
			ensureNotReloading();
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
					content: [{ type: "text", text: formatWaitForAgentsResult(details) }],
					details,
				};
			}
			const result = await teamManager.waitForTerminal(targetIds, {
				timeoutMs: params.timeoutMs ?? 300_000,
				signal,
				wakeOnRelay: params.wakeOnRelay !== false,
			});
			const details: WaitDetails = { reason: result.reason, workers: result.workers };
			if (result.newRelays) details.newRelays = result.newRelays;
			return {
				content: [{ type: "text", text: formatWaitForAgentsResult(details) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "agent_cancel",
		label: "Agent Cancel",
		description: "Abort and shut down a tracked worker.",
		parameters: WorkerIdSchema,
		constrainedSampling: PREFERRED_JSON_SCHEMA_SAMPLING,
		renderCall: renderAgentToolCallTitle("agent_cancel"),
		async execute(_toolCallId, params) {
			ensureNotReloading();
			const workerId = teamManager.resolveWorkerId(params.workerId) ?? params.workerId;
			const result = await teamManager.cancelWorker(workerId);
			return {
				content: [{ type: "text", text: `Cancelled ${formatWorkerLabel(result.worker)}.` }],
				details: result,
			};
		},
	});

	pi.on("session_start", async (event, ctx) => {
		stopTipRotation();
		activeContext = ctx;
		piVersionMismatchNotifier.reset();
		reloading = true;
		try {
			activeProjectConfig = loadActiveTeamConfig({
				cwd: ctx.cwd,
				baseConfig: DEFAULT_TEAM_CONFIG,
				projectConfigTrusted: isProjectConfigTrustedForContext(ctx),
			});
			updateDelegateTaskProfileDescription(activeProjectConfig.config);
			updateDelegateTaskModelDescription((ctx as unknown as { scopedModels?: unknown }).scopedModels);
			await replaceTeamManager(activeProjectConfig.config);
			const { state, markedCount, persistenceMeasurement } = restoreLatestState(ctx, event.reason, activeProjectConfig.config);
			teamState = state;
			provisionalTreeNavigation = undefined;
			persistenceGrowth.replace(persistenceMeasurement, isPersistedSession(ctx));
			restoredWorkerIds.clear();
			for (const workerId of Object.keys(teamState.activeWorkers)) restoredWorkerIds.add(workerId);
			persistenceJournal.reset(teamState, activeProjectConfig.config);
			teamManager.restore(teamState);
			registerTeamAutocomplete(ctx, {
				getWorkers: () => teamManager.listWorkers(),
				getProfiles: () => activeProjectConfig.config.profiles,
			});
			renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);

			if (!ctx.hasUI) return;

			if (activeProjectConfig.enabled) {
				ctx.ui.notify("Team ready — orchestrator mode", "info");
			}
			const configNotice = getProjectConfigNotice(activeProjectConfig);
			if (configNotice) {
				ctx.ui.notify(configNotice.message, configNotice.level);
			}

			notifyActiveConfigFreshness(ctx, activeProjectConfig);
			notifyThinkingLevelWarnings(ctx, activeProjectConfig.thinkingLevelWarnings);

			if (event.reason !== "startup" && markedCount > 0 && isTeamActive(activeProjectConfig)) {
				const noun = markedCount === 1 ? "worker" : "workers";
				ctx.ui.notify(
					`Workers exited — ${markedCount} ${noun} restored from ${event.reason}; relaunch if needed.`,
					"warning",
				);
			}
		} finally {
			reloading = false;
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		// Pi fires this before summary generation and before moving the leaf.
		// Persist detached representations of live workers on the origin branch,
		// but do not dispose or cancel their runtimes: cancellation/abort emits no
		// session_tree and those workers must remain usable.
		activeContext = ctx;
		const sessionManager = currentSessionManager();
		const leafId = currentLeafId();
		const originLeafId = leafId !== undefined ? leafId : event.preparation.oldLeafId;
		const originBranchEntryIds = new Set(
			Array.from(sessionManager?.getBranch?.() ?? [])
				.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []),
		);
		const preexistingEntryIds = new Set(
			Array.from(sessionManager?.getEntries?.() ?? [])
				.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []),
		);
		const navigation: ProvisionalTreeNavigation = {
			originLeafId,
			appendLeafId: originLeafId,
			confirmed: false,
			rootDispatchBlocked: false,
			originBranchEntryIds,
			preexistingEntryIds,
		};
		provisionalTreeNavigation = navigation;
		event.signal?.addEventListener("abort", () => {
			if (provisionalTreeNavigation === navigation && !navigation.confirmed) {
				navigation.rootDispatchBlocked = false;
			}
		}, { once: true });
		persistenceJournal.prepareDetachedWorkers(teamState, activeProjectConfig.config);
		attemptBoundedPersistenceFlush();
		navigation.rootDispatchBlocked = originLeafId === null;
	});

	pi.on("session_tree", async (event, ctx) => {
		activeContext = ctx;
		// This event is the first confirmation that Pi has moved the leaf. Isolate
		// the unresolved old suffix now—not during the provisional before hook.
		const hadUnresolvedOldRecords = persistenceJournal.hasPending();
		const provisional = provisionalTreeNavigation;
		provisionalTreeNavigation = {
			originLeafId: event.oldLeafId,
			appendLeafId: event.oldLeafId,
			confirmed: true,
			rootDispatchBlocked: false,
			originBranchEntryIds: provisional?.originBranchEntryIds ?? new Set<string>(),
			preexistingEntryIds: provisional?.preexistingEntryIds ?? new Set<string>(),
		};
		persistenceJournal.discardPending();
		if (hadUnresolvedOldRecords) warnPersistenceFailure(PERSISTENCE_TREE_DROP_WARNING);
		reloading = true;
		try {
			await replaceTeamManager(activeProjectConfig.config);
			const { state, persistenceMeasurement } = restoreLatestState(ctx, "reload", activeProjectConfig.config);
			teamState = state;
			persistenceGrowth.replace(persistenceMeasurement, isPersistedSession(ctx));
			restoredWorkerIds.clear();
			for (const workerId of Object.keys(teamState.activeWorkers)) restoredWorkerIds.add(workerId);
			persistenceJournal.reset(teamState, activeProjectConfig.config);
			provisionalTreeNavigation = undefined;
			teamManager.restore(teamState);
			renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
		} finally {
			provisionalTreeNavigation = undefined;
			reloading = false;
		}
	});

	function releaseCancelledTreeNavigation(): void {
		if (provisionalTreeNavigation && !provisionalTreeNavigation.confirmed) {
			provisionalTreeNavigation = undefined;
		}
	}

	pi.on("agent_start", async (_event, ctx) => {

		activeContext = ctx;
		orchestratorWorking = true;
		releaseCancelledTreeNavigation();
		teamState = teamManager.snapshot();
		renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeContext = ctx;
		teamState = teamManager.snapshot();
		renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeContext = ctx;
		orchestratorWorking = false;
		teamState = teamManager.snapshot();
		renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeContext = ctx;
		releaseCancelledTreeNavigation();
		orchestratorWorking = true;
		teamState = teamManager.snapshot();
		renderUi(ctx, teamState, spinnerFrame, activeProjectConfig.config, isTeamActive(activeProjectConfig), teamManager.routingMode, activeProjectConfig.displayCost);
		if (!activeProjectConfig.enabled) {
			return { systemPrompt: event.systemPrompt };
		}
		const projectConfigPromptNote = getProjectConfigPromptNote(activeProjectConfig);
		return {
			systemPrompt: [
				event.systemPrompt,
				buildOrchestratorPromptBundle(teamState, activeProjectConfig.config, teamManager.routingMode),
				projectConfigPromptNote,
			].filter((item): item is string => Boolean(item)).join("\n\n"),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinner();
		stopTipRotation();
		if (provisionalTreeNavigation && !provisionalTreeNavigation.confirmed) provisionalTreeNavigation = undefined;
		try {
			// Keep the listener attached: disposal may synchronously publish exited
			// terminal workers that must become compact persistence records.
			await teamManager.dispose();
		} finally {
			teamState = teamManager.snapshot();
			flushPendingPersistence();
			detachTeamManagerListener(false);
			clearUi(ctx, activeProjectConfig.config);
			orchestratorWorking = false;
			activeContext = undefined;
		}
	});
}
