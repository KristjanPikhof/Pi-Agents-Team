import { createDefaultTeamState, DEFAULT_TEAM_CONFIG, normalizePersistedTeamState } from "../config.js";
import { addWorkerUsageToAggregate } from "../usage.js";
import {
	TEAM_PERSISTENCE_VERSION,
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

const LIVE_WORKER_STATUSES: readonly WorkerStatus[] = ["running", "starting", "idle", "waiting_followup"];
const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set(["idle", "completed", "aborted", "error", "exited"]);
const MAX_ID_LENGTH = 256;
const MAX_SUMMARY_TEXT_LENGTH = 512;
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

function cap(value: unknown, max = MAX_SUMMARY_TEXT_LENGTH): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function compactWorker(worker: WorkerRuntimeState, config: TeamConfig): CompactPersistedWorker {
	const summary = worker.lastSummary;
	return {
		workerId: cap(worker.workerId, MAX_ID_LENGTH),
		profileName: cap(worker.profileName, MAX_ID_LENGTH),
		status: worker.status,
		startedAt: finite(worker.startedAt),
		lastEventAt: finite(worker.lastEventAt),
		lastSummary: summary ? {
			headline: cap(summary.headline, config.summaries.maxHeadlineLength),
			status: worker.status,
			readFiles: summary.readFiles.slice(0, config.summaries.maxItemsPerWorker).map((item) => cap(item)),
			changedFiles: summary.changedFiles.slice(0, config.summaries.maxChangedFiles).map((item) => cap(item)),
			risks: summary.risks.slice(0, config.summaries.maxItemsPerWorker).map((item) => cap(item)),
			nextRecommendation: summary.nextRecommendation ? cap(summary.nextRecommendation) : undefined,
			updatedAt: finite(summary.updatedAt),
		} : undefined,
		usage: compactUsage(worker.usage),
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

function isV2Record(value: unknown): value is TeamPersistenceRecord {
	if (!isRecord(value) || value.version !== TEAM_PERSISTENCE_VERSION || typeof value.recordId !== "string") return false;
	return value.kind === "worker_terminal" || value.kind === "worker_pruned";
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

export function restorePersistedTeamState(
	entries: Iterable<SessionLikeEntry>,
	stateCustomType: string,
): PersistedTeamState {
	let state = createDefaultTeamState();
	const appliedRecords = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== stateCustomType) continue;
		if (!isV2Record(entry.data)) {
			state = sanitizeLegacyState(entry.data);
			appliedRecords.clear();
			continue;
		}
		const record = entry.data;
		if (appliedRecords.has(record.recordId)) continue;
		appliedRecords.add(record.recordId);
		if (record.kind === "worker_terminal" && isRecord(record.worker)) {
			const worker = record.worker as unknown as CompactPersistedWorker;
			if (typeof worker.workerId === "string" && typeof worker.profileName === "string") {
				state.activeWorkers[worker.workerId] = restoredWorker(worker);
			}
		} else if (record.kind === "worker_pruned" && typeof record.workerId === "string") {
			delete state.activeWorkers[record.workerId];
			state.prunedWorkerUsageTotals = addWorkerUsageToAggregate(state.prunedWorkerUsageTotals, compactUsage(record.usage));
		}
	}
	return normalizePersistedTeamState(state);
}

export function markRestoredWorkersExited(
	state: PersistedTeamState,
	reasonOrStartReason: string | SessionStartReason = "reload",
): MarkRestoredWorkersExitedResult {
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
			if (worker.lastSummary) {
				worker.lastSummary.status = "exited";
				worker.lastSummary.headline = reason;
				worker.lastSummary.updatedAt = timestamp;
			}
			markedCount += 1;
		}
	}
	nextState.updatedAt = timestamp;
	nextState.ui.lastRenderAt = timestamp;
	return { state: nextState, markedCount };
}

function recordId(kind: string, payload: unknown): string {
	const text = JSON.stringify(payload);
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
	return `${kind}:${(hash >>> 0).toString(36)}:${text.length}`;
}

export class CompactPersistenceJournal {
	private previousWorkers = new Map<string, CompactPersistedWorker>();
	private persistedFingerprints = new Map<string, string>();

	reset(state: PersistedTeamState, config: TeamConfig): void {
		this.previousWorkers.clear();
		this.persistedFingerprints.clear();
		for (const worker of Object.values(state.activeWorkers)) {
			const compact = compactWorker(worker, config);
			this.previousWorkers.set(worker.workerId, compact);
			if (TERMINAL_WORKER_STATUSES.has(worker.status)) this.persistedFingerprints.set(worker.workerId, JSON.stringify(compact));
		}
	}

	collect(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		const records: TeamPersistenceRecord[] = [];
		const currentIds = new Set(Object.keys(state.activeWorkers));
		for (const [workerId, previous] of this.previousWorkers) {
			if (currentIds.has(workerId)) continue;
			const payload = { workerId: previous.workerId, usage: previous.usage, lastEventAt: previous.lastEventAt };
			records.push({ version: TEAM_PERSISTENCE_VERSION, kind: "worker_pruned", recordId: recordId("prune", payload), workerId: previous.workerId, usage: previous.usage });
			this.persistedFingerprints.delete(workerId);
		}
		this.previousWorkers.clear();
		for (const worker of Object.values(state.activeWorkers)) {
			const compact = compactWorker(worker, config);
			this.previousWorkers.set(worker.workerId, compact);
			if (!TERMINAL_WORKER_STATUSES.has(worker.status)) continue;
			const fingerprint = JSON.stringify(compact);
			if (this.persistedFingerprints.get(worker.workerId) === fingerprint) continue;
			const record: TeamPersistenceRecord = { version: TEAM_PERSISTENCE_VERSION, kind: "worker_terminal", recordId: recordId("terminal", compact), worker: compact };
			if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_BYTES) throw new Error(`Compact persistence record exceeded ${MAX_RECORD_BYTES} bytes`);
			records.push(record);
			this.persistedFingerprints.set(worker.workerId, fingerprint);
		}
		return records;
	}
}
