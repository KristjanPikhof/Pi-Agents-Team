import { createHash } from "node:crypto";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG, normalizePersistedTeamState } from "../config.js";
import { addWorkerUsageToAggregate } from "../usage.js";
import {
	TEAM_PERSISTENCE_VERSION,
	WORKER_STATUSES,
	type CompactPersistedWorker,
	type PersistedTeamState,
	type TeamConfig,
	type TeamPersistenceRecord,
	type WorkerRuntimeState,
	type WorkerStatus,
	type WorkerUsageStats,
} from "../types.js";

interface SessionLikeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface MarkRestoredWorkersExitedResult {
	state: PersistedTeamState;
	markedCount: number;
}

export interface CompactPersistenceMeasurement {
	recordCount: number;
	payloadBytes: number;
}

const LIVE_WORKER_STATUSES: readonly WorkerStatus[] = ["running", "starting", "idle", "waiting_followup"];
const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set(["idle", "completed", "aborted", "error", "exited"]);
const WORKER_STATUS_SET: ReadonlySet<string> = new Set(WORKER_STATUSES);
const MAX_ID_BYTES = 256;
const MAX_SUMMARY_TEXT_BYTES = 512;
const MAX_RECORD_BYTES = 16 * 1024;

const REASON_MESSAGE: Record<SessionStartReason, string> = {
	startup: "Pi Agents Team session restored; relaunch required for live worker control.",
	reload: "Pi Agents Team session reloaded; relaunch required for live worker control.",
	resume: "Pi Agents Team session resumed; relaunch required for live worker control.",
	fork: "Pi Agents Team session forked; relaunch required for live worker control.",
	new: "Pi Agents Team new session started; prior workers are no longer attached.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compactUsage(usage: Partial<WorkerUsageStats> | undefined): WorkerUsageStats {
	const result: WorkerUsageStats = {
		turns: finite(usage?.turns),
		inputTokens: finite(usage?.inputTokens),
		outputTokens: finite(usage?.outputTokens),
		cacheReadTokens: finite(usage?.cacheReadTokens),
		cacheWriteTokens: finite(usage?.cacheWriteTokens),
		costUsd: finite(usage?.costUsd),
	};
	for (const key of ["contextTokens", "contextWindow", "contextPercent", "contextRemainingTokens"] as const) {
		if (typeof usage?.[key] === "number" && Number.isFinite(usage[key])) result[key] = usage[key];
	}
	return result;
}

/** Truncate only at Unicode code-point boundaries, using the serialized UTF-8 budget. */
function cap(value: unknown, maxBytes = MAX_SUMMARY_TEXT_BYTES): string {
	if (typeof value !== "string" || maxBytes <= 0) return "";
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function compactStrings(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, Math.max(0, Math.floor(maxItems))).map((item) => cap(item));
}

function compactWorker(worker: WorkerRuntimeState, config: TeamConfig): CompactPersistedWorker {
	const summary = worker.lastSummary;
	return {
		workerId: cap(worker.workerId, MAX_ID_BYTES),
		profileName: cap(worker.profileName, MAX_ID_BYTES),
		status: worker.status,
		startedAt: finite(worker.startedAt),
		lastEventAt: finite(worker.lastEventAt),
		lastSummary: summary ? {
			headline: cap(summary.headline, config.summaries.maxHeadlineLength),
			status: worker.status,
			readFiles: compactStrings(summary.readFiles, config.summaries.maxItemsPerWorker),
			changedFiles: compactStrings(summary.changedFiles, config.summaries.maxChangedFiles),
			risks: compactStrings(summary.risks, config.summaries.maxItemsPerWorker),
			nextRecommendation: summary.nextRecommendation ? cap(summary.nextRecommendation) : undefined,
			updatedAt: finite(summary.updatedAt),
		} : undefined,
		usage: compactUsage(worker.usage),
	};
}

function sanitizeCompactWorker(value: unknown): CompactPersistedWorker | undefined {
	if (!isRecord(value) || typeof value.workerId !== "string" || typeof value.profileName !== "string") return undefined;
	if (typeof value.status !== "string" || !WORKER_STATUS_SET.has(value.status)) return undefined;
	const summary = isRecord(value.lastSummary) && typeof value.lastSummary.status === "string" && WORKER_STATUS_SET.has(value.lastSummary.status)
		? {
			headline: cap(value.lastSummary.headline),
			status: value.lastSummary.status as WorkerStatus,
			readFiles: compactStrings(value.lastSummary.readFiles, 64),
			changedFiles: compactStrings(value.lastSummary.changedFiles, 64),
			risks: compactStrings(value.lastSummary.risks, 64),
			nextRecommendation: typeof value.lastSummary.nextRecommendation === "string" ? cap(value.lastSummary.nextRecommendation) : undefined,
			updatedAt: finite(value.lastSummary.updatedAt),
		}
		: undefined;
	return {
		workerId: cap(value.workerId, MAX_ID_BYTES),
		profileName: cap(value.profileName, MAX_ID_BYTES),
		status: value.status as WorkerStatus,
		startedAt: finite(value.startedAt),
		lastEventAt: finite(value.lastEventAt),
		lastSummary: summary,
		usage: compactUsage(isRecord(value.usage) ? value.usage : undefined),
	};
}

function restoredWorker(worker: CompactPersistedWorker): WorkerRuntimeState {
	return {
		workerId: worker.workerId,
		profileName: worker.profileName,
		sessionMode: "worker",
		status: worker.status,
		requestedThinkingLevel: "off",
		effectiveThinkingLevel: "off",
		startedAt: worker.startedAt,
		lastEventAt: worker.lastEventAt,
		pendingRelayQuestions: [],
		usage: compactUsage(worker.usage),
		lastSummary: worker.lastSummary ? {
			workerId: worker.workerId,
			taskId: worker.workerId,
			...worker.lastSummary,
			currentToolName: undefined,
			relayQuestionCount: 0,
		} : undefined,
	};
}

function isLegacySnapshot(value: unknown): boolean {
	return isRecord(value) && value.version === 1 && isRecord(value.activeWorkers);
}

/** True only for replayable records in the current compact format. */
export function isRecognizedCompactPersistenceRecord(value: unknown): value is TeamPersistenceRecord {
	if (!isRecord(value) || value.version !== TEAM_PERSISTENCE_VERSION || typeof value.recordId !== "string") return false;
	if (value.kind === "worker_terminal") return sanitizeCompactWorker(value.worker) !== undefined;
	return value.kind === "worker_pruned" && typeof value.workerId === "string" && isRecord(value.usage);
}

/** UTF-8 bytes occupied by the compact record payload, not session framing or total file bytes. */
export function compactPersistenceRecordPayloadBytes(record: TeamPersistenceRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

export function measureCompactPersistence(
	entries: Iterable<SessionLikeEntry>,
	stateCustomType: string,
): CompactPersistenceMeasurement {
	let recordCount = 0;
	let payloadBytes = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== stateCustomType) continue;
		if (!isRecognizedCompactPersistenceRecord(entry.data)) continue;
		recordCount += 1;
		payloadBytes += compactPersistenceRecordPayloadBytes(entry.data);
	}
	return { recordCount, payloadBytes };
}

function sanitizeLegacyState(raw: unknown): PersistedTeamState {
	const legacy = normalizePersistedTeamState(raw);
	const state = createDefaultTeamState();
	state.prunedWorkerUsageTotals = legacy.prunedWorkerUsageTotals;
	for (const worker of Object.values(legacy.activeWorkers)) {
		if (!worker || typeof worker.workerId !== "string" || typeof worker.profileName !== "string") continue;
		const compact = compactWorker({
			...worker,
			pendingRelayQuestions: [],
			finalAnswer: undefined,
			currentTask: undefined,
			lastToolName: undefined,
			processId: undefined,
			error: undefined,
		}, DEFAULT_TEAM_CONFIG);
		state.activeWorkers[compact.workerId] = restoredWorker(compact);
	}
	return normalizePersistedTeamState(state);
}

export function restorePersistedTeamState(entries: Iterable<SessionLikeEntry>, stateCustomType: string): PersistedTeamState {
	let state = createDefaultTeamState();
	const appliedRecords = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== stateCustomType) continue;
		const value = entry.data;
		if (isLegacySnapshot(value)) {
			state = sanitizeLegacyState(value);
			appliedRecords.clear();
			continue;
		}
		// Unknown, malformed, and future-version records are inert. In particular,
		// they must not erase the valid replay prefix as an alleged legacy snapshot.
		if (!isRecognizedCompactPersistenceRecord(value)) continue;
		if (appliedRecords.has(value.recordId)) continue;

		if (value.kind === "worker_terminal") {
			const worker = sanitizeCompactWorker(value.worker);
			if (!worker) continue;
			appliedRecords.add(value.recordId);
			state.activeWorkers[worker.workerId] = restoredWorker(worker);
		} else {
			if (typeof value.workerId !== "string" || !isRecord(value.usage)) continue;
			appliedRecords.add(value.recordId);
			const workerId = cap(value.workerId, MAX_ID_BYTES);
			delete state.activeWorkers[workerId];
			state.prunedWorkerUsageTotals = addWorkerUsageToAggregate(state.prunedWorkerUsageTotals, compactUsage(value.usage));
		}
	}
	return normalizePersistedTeamState(state);
}

export function markRestoredWorkersExited(state: PersistedTeamState, reasonOrStartReason: string | SessionStartReason = "reload"): MarkRestoredWorkersExitedResult {
	const nextState = normalizePersistedTeamState(state);
	const timestamp = Date.now();
	const reason = reasonOrStartReason in REASON_MESSAGE
		? REASON_MESSAGE[reasonOrStartReason as SessionStartReason]
		: reasonOrStartReason;
	let markedCount = 0;
	for (const worker of Object.values(nextState.activeWorkers)) {
		if (LIVE_WORKER_STATUSES.includes(worker.status)) {
			worker.status = "exited";
			worker.error = reason;
			worker.lastEventAt = timestamp;
			// A restored summary is the worker's durable result, not an activity
			// message. Preserve it verbatim while detaching the unavailable runtime.
			markedCount += 1;
		}
	}
	nextState.updatedAt = timestamp;
	nextState.ui.lastRenderAt = timestamp;
	return { state: nextState, markedCount };
}

function recordId(kind: string, payload: unknown): string {
	return `${kind}:${createHash("sha256").update(JSON.stringify(payload)).digest("base64url")}`;
}

function recordBytes(record: TeamPersistenceRecord): number {
	return compactPersistenceRecordPayloadBytes(record);
}

function terminalRecord(source: CompactPersistedWorker): TeamPersistenceRecord {
	const worker = structuredClone(source);
	const build = (): TeamPersistenceRecord => ({
		version: TEAM_PERSISTENCE_VERSION,
		kind: "worker_terminal",
		recordId: recordId("terminal", worker),
		worker,
	});
	let record = build();
	// Configured list limits may be arbitrarily large. Remove tail items in a
	// stable order until the complete JSON record (including its hash) fits.
	while (recordBytes(record) > MAX_RECORD_BYTES && worker.lastSummary) {
		const summary = worker.lastSummary;
		if (summary.risks.length) summary.risks.pop();
		else if (summary.readFiles.length) summary.readFiles.pop();
		else if (summary.changedFiles.length) summary.changedFiles.pop();
		else if (summary.nextRecommendation) summary.nextRecommendation = undefined;
		else if (Buffer.byteLength(summary.headline, "utf8") > 0) summary.headline = cap(summary.headline, Math.floor(Buffer.byteLength(summary.headline, "utf8") / 2));
		else worker.lastSummary = undefined;
		record = build();
	}
	return record;
}

function durableWorkerValue(worker: CompactPersistedWorker): unknown {
	return {
		workerId: worker.workerId,
		profileName: worker.profileName,
		status: worker.status,
		startedAt: worker.startedAt,
		lastSummary: worker.lastSummary,
		usage: worker.usage,
	};
}

function durableEqual(left: CompactPersistedWorker, right: CompactPersistedWorker): boolean {
	return JSON.stringify(durableWorkerValue(left)) === JSON.stringify(durableWorkerValue(right));
}

type PendingTransition =
	| { record: Extract<TeamPersistenceRecord, { kind: "worker_terminal" }>; worker: CompactPersistedWorker }
	| { record: Extract<TeamPersistenceRecord, { kind: "worker_pruned" }>; workerId: string };

/** Compact v2 transition journal with append-before-commit semantics. */
export class CompactPersistenceJournal {
	private previousWorkers = new Map<string, CompactPersistedWorker>();
	private pending = new Map<string, PendingTransition>();

	reset(state: PersistedTeamState, config: TeamConfig): void {
		this.previousWorkers.clear();
		this.pending.clear();
		for (const worker of Object.values(state.activeWorkers)) this.previousWorkers.set(worker.workerId, compactWorker(worker, config));
	}

	prepare(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		if (this.pending.size) return [...this.pending.values()].map((transition) => transition.record);

		const currentIds = new Set(Object.keys(state.activeWorkers));
		for (const [workerId, previous] of this.previousWorkers) {
			if (currentIds.has(workerId)) continue;
			const payload = { workerId: previous.workerId, usage: previous.usage, lastEventAt: previous.lastEventAt };
			const record: Extract<TeamPersistenceRecord, { kind: "worker_pruned" }> = {
				version: TEAM_PERSISTENCE_VERSION,
				kind: "worker_pruned",
				recordId: recordId("prune", payload),
				workerId: previous.workerId,
				usage: previous.usage,
			};
			this.pending.set(record.recordId, { record, workerId });
		}

		for (const worker of Object.values(state.activeWorkers)) {
			const compact = compactWorker(worker, config);
			const previous = this.previousWorkers.get(worker.workerId);
			if (!TERMINAL_WORKER_STATUSES.has(worker.status)) {
				// Runtime-only churn needs no append, but remains the source for a
				// later terminal/prune transition.
				this.previousWorkers.set(worker.workerId, compact);
				continue;
			}
			if (previous && TERMINAL_WORKER_STATUSES.has(previous.status) && durableEqual(previous, compact)) continue;
			const record = terminalRecord(compact) as Extract<TeamPersistenceRecord, { kind: "worker_terminal" }>;
			this.pending.set(record.recordId, { record, worker: record.worker });
		}
		return [...this.pending.values()].map((transition) => transition.record);
	}

	commit(record: TeamPersistenceRecord): void {
		const transition = this.pending.get(record.recordId);
		if (!transition) return;
		if ("worker" in transition) this.previousWorkers.set(transition.worker.workerId, transition.worker);
		else this.previousWorkers.delete(transition.workerId);
		this.pending.delete(record.recordId);
	}

	/** Compatibility helper for non-I/O callers; append wiring must use prepare/commit. */
	collect(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		const records = this.prepare(state, config);
		for (const record of records) this.commit(record);
		return records;
	}
}
