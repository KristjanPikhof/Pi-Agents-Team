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

export interface RestorePersistedTeamStateWithMeasurementResult {
	state: PersistedTeamState;
	measurement: CompactPersistenceMeasurement;
}

const LIVE_WORKER_STATUSES: readonly WorkerStatus[] = ["running", "starting", "idle", "waiting_followup"];
const TERMINAL_WORKER_STATUS: Partial<Record<WorkerStatus, true>> = {
	idle: true,
	completed: true,
	aborted: true,
	error: true,
	exited: true,
};
const MAX_ID_BYTES = 256;
const MAX_RECORD_ID_BYTES = 256;
const MAX_SUMMARY_TEXT_BYTES = 512;
const MAX_SUMMARY_ITEMS = 64;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_PERSISTED_NUMBER = Number.MAX_SAFE_INTEGER;

const REASON_MESSAGE: Record<SessionStartReason, string> = {
	startup: "Pi Agents Team session restored; relaunch required for live worker control.",
	reload: "Pi Agents Team session reloaded; relaunch required for live worker control.",
	resume: "Pi Agents Team session resumed; relaunch required for live worker control.",
	fork: "Pi Agents Team session forked; relaunch required for live worker control.",
	new: "Pi Agents Team new session started; prior workers are no longer attached.",
};

function isPersistableTerminalStatus(status: unknown): status is WorkerStatus {
	return typeof status === "string" && TERMINAL_WORKER_STATUS[status as WorkerStatus] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, MAX_PERSISTED_NUMBER)
		: 0;
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
		const value = usage?.[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			result[key] = Math.min(value, MAX_PERSISTED_NUMBER);
		}
	}
	return result;
}

/** Truncate only at Unicode code-point boundaries, using the serialized UTF-8 budget. */
function cap(value: unknown, maxBytes = MAX_SUMMARY_TEXT_BYTES): string {
	if (typeof value !== "string" || maxBytes <= 0) return "";
	const characters: string[] = [];
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		characters.push(character);
		bytes += characterBytes;
	}
	return characters.join("");
}

function compactStrings(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	const configuredLimit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : 0;
	return value.slice(0, Math.min(configuredLimit, MAX_SUMMARY_ITEMS)).map((item) => cap(item));
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
			headline: cap(summary.headline, Math.min(config.summaries.maxHeadlineLength, MAX_SUMMARY_TEXT_BYTES)),
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key))
		&& keys.every((key) => required.includes(key) || optional.includes(key));
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = true): value is string {
	return typeof value === "string"
		&& (allowEmpty || value.length > 0)
		&& Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isBoundedNumber(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isFinite(value)
		&& value >= 0
		&& value <= MAX_PERSISTED_NUMBER;
}

function sanitizeUsage(value: unknown): WorkerUsageStats | undefined {
	if (!isPlainRecord(value)) return undefined;
	const required = ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
	const optional = ["contextTokens", "contextWindow", "contextPercent", "contextRemainingTokens"] as const;
	if (!hasExactKeys(value, required, optional)) return undefined;
	for (const key of required) {
		if (!isBoundedNumber(value[key])) return undefined;
	}
	const usage: WorkerUsageStats = {
		turns: value.turns as number,
		inputTokens: value.inputTokens as number,
		outputTokens: value.outputTokens as number,
		cacheReadTokens: value.cacheReadTokens as number,
		cacheWriteTokens: value.cacheWriteTokens as number,
		costUsd: value.costUsd as number,
	};
	for (const key of optional) {
		if (!Object.hasOwn(value, key)) continue;
		if (!isBoundedNumber(value[key])) return undefined;
		usage[key] = value[key] as number;
	}
	return usage;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_SUMMARY_ITEMS) return undefined;
	const keys = Object.keys(value);
	if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return undefined;
	if (!value.every((item) => isBoundedString(item, MAX_SUMMARY_TEXT_BYTES))) return undefined;
	return [...value];
}

function sanitizeCompactWorker(value: unknown): CompactPersistedWorker | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (!hasExactKeys(
		value,
		["workerId", "profileName", "status", "startedAt", "lastEventAt", "usage"],
		["lastSummary"],
	)) return undefined;
	if (!isBoundedString(value.workerId, MAX_ID_BYTES, false) || !isBoundedString(value.profileName, MAX_ID_BYTES, false)) return undefined;
	if (!isPersistableTerminalStatus(value.status)) return undefined;
	if (!isBoundedNumber(value.startedAt) || !isBoundedNumber(value.lastEventAt)) return undefined;
	const usage = sanitizeUsage(value.usage);
	if (!usage) return undefined;
	let lastSummary: CompactPersistedWorker["lastSummary"];
	if (Object.hasOwn(value, "lastSummary") && value.lastSummary !== undefined) {
		if (!isPlainRecord(value.lastSummary)) return undefined;
		if (!hasExactKeys(
			value.lastSummary,
			["headline", "status", "readFiles", "changedFiles", "risks", "updatedAt"],
			["nextRecommendation"],
		)) return undefined;
		if (value.lastSummary.status !== value.status) return undefined;
		if (!isBoundedString(value.lastSummary.headline, MAX_SUMMARY_TEXT_BYTES)) return undefined;
		const readFiles = sanitizeStringArray(value.lastSummary.readFiles);
		const changedFiles = sanitizeStringArray(value.lastSummary.changedFiles);
		const risks = sanitizeStringArray(value.lastSummary.risks);
		if (!readFiles || !changedFiles || !risks || !isBoundedNumber(value.lastSummary.updatedAt)) return undefined;
		if (Object.hasOwn(value.lastSummary, "nextRecommendation")
			&& value.lastSummary.nextRecommendation !== undefined
			&& !isBoundedString(value.lastSummary.nextRecommendation, MAX_SUMMARY_TEXT_BYTES)) return undefined;
		lastSummary = {
			headline: value.lastSummary.headline,
			status: value.status as WorkerStatus,
			readFiles,
			changedFiles,
			risks,
			nextRecommendation: value.lastSummary.nextRecommendation as string | undefined,
			updatedAt: value.lastSummary.updatedAt,
		};
	}
	return {
		workerId: value.workerId,
		profileName: value.profileName,
		status: value.status as WorkerStatus,
		startedAt: value.startedAt,
		lastEventAt: value.lastEventAt,
		lastSummary,
		usage,
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

interface InspectedCompactPersistenceRecord {
	record: TeamPersistenceRecord;
	payloadBytes: number;
}

/**
 * Validate and canonicalize a compact record in one pass. The canonical copy
 * is the only value serialized and is reused by replay.
 */
function inspectCompactPersistenceRecord(value: unknown): InspectedCompactPersistenceRecord | undefined {
	if (!isPlainRecord(value) || value.version !== TEAM_PERSISTENCE_VERSION) return undefined;
	if (!isBoundedString(value.recordId, MAX_RECORD_ID_BYTES, false)) return undefined;

	let record: TeamPersistenceRecord;
	if (value.kind === "worker_terminal") {
		if (!hasExactKeys(value, ["version", "kind", "recordId", "worker"])) return undefined;
		const worker = sanitizeCompactWorker(value.worker);
		if (!worker) return undefined;
		record = {
			version: TEAM_PERSISTENCE_VERSION,
			kind: "worker_terminal",
			recordId: value.recordId,
			worker,
		};
	} else if (value.kind === "worker_pruned") {
		if (!hasExactKeys(value, ["version", "kind", "recordId", "workerId", "usage"])) return undefined;
		if (!isBoundedString(value.workerId, MAX_ID_BYTES, false)) return undefined;
		const usage = sanitizeUsage(value.usage);
		if (!usage) return undefined;
		record = {
			version: TEAM_PERSISTENCE_VERSION,
			kind: "worker_pruned",
			recordId: value.recordId,
			workerId: value.workerId,
			usage,
		};
	} else {
		return undefined;
	}

	const payloadBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
	if (payloadBytes > MAX_RECORD_BYTES) return undefined;
	return { record, payloadBytes };
}

/** True only for replayable records in the current compact format. */
export function isRecognizedCompactPersistenceRecord(value: unknown): value is TeamPersistenceRecord {
	return inspectCompactPersistenceRecord(value) !== undefined;
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
		const inspected = inspectCompactPersistenceRecord(entry.data);
		if (!inspected) continue;
		recordCount += 1;
		payloadBytes += inspected.payloadBytes;
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

export function restorePersistedTeamStateWithMeasurement(
	entries: Iterable<SessionLikeEntry>,
	stateCustomType: string,
): RestorePersistedTeamStateWithMeasurementResult {
	let state = createDefaultTeamState();
	const appliedRecords = new Set<string>();
	const measurement: CompactPersistenceMeasurement = { recordCount: 0, payloadBytes: 0 };

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
		const inspected = inspectCompactPersistenceRecord(value);
		if (!inspected) continue;
		measurement.recordCount += 1;
		measurement.payloadBytes += inspected.payloadBytes;

		const record = inspected.record;
		if (appliedRecords.has(record.recordId)) continue;
		appliedRecords.add(record.recordId);
		if (record.kind === "worker_terminal") {
			state.activeWorkers[record.worker.workerId] = restoredWorker(record.worker);
		} else {
			delete state.activeWorkers[record.workerId];
			state.prunedWorkerUsageTotals = addWorkerUsageToAggregate(
				state.prunedWorkerUsageTotals,
				record.usage,
			);
		}
	}
	return { state: normalizePersistedTeamState(state), measurement };
}

export function restorePersistedTeamState(entries: Iterable<SessionLikeEntry>, stateCustomType: string): PersistedTeamState {
	return restorePersistedTeamStateWithMeasurement(entries, stateCustomType).state;
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

export interface CompactPersistenceJournalInstrumentation {
	onRecordHash?(kind: "terminal" | "prune"): void;
}

function recordId(
	kind: "terminal" | "prune",
	payload: unknown,
	instrumentation?: CompactPersistenceJournalInstrumentation,
): string {
	instrumentation?.onRecordHash?.(kind);
	return `${kind}:${createHash("sha256").update(JSON.stringify(payload)).digest("base64url")}`;
}

function recordBytes(record: TeamPersistenceRecord): number {
	return compactPersistenceRecordPayloadBytes(record);
}

function terminalRecord(
	source: CompactPersistedWorker,
	instrumentation?: CompactPersistenceJournalInstrumentation,
): Extract<TeamPersistenceRecord, { kind: "worker_terminal" }> {
	const worker = structuredClone(source);
	const build = (): Extract<TeamPersistenceRecord, { kind: "worker_terminal" }> => ({
		version: TEAM_PERSISTENCE_VERSION,
		kind: "worker_terminal",
		recordId: recordId("terminal", worker, instrumentation),
		worker,
	});
	const finish = (
		candidate: Extract<TeamPersistenceRecord, { kind: "worker_terminal" }>,
	): Extract<TeamPersistenceRecord, { kind: "worker_terminal" }> => {
		const inspected = inspectCompactPersistenceRecord(candidate);
		if (!inspected || inspected.record.kind !== "worker_terminal") {
			throw new Error("Compact persistence terminal writer produced an unreadable record.");
		}
		return inspected.record;
	};
	let record = build();
	if (recordBytes(record) <= MAX_RECORD_BYTES) return finish(record);

	const summary = worker.lastSummary;
	if (summary) {
		for (const field of ["risks", "readFiles", "changedFiles"] as const) {
			const values = [...summary[field]];
			if (values.length === 0) continue;
			summary[field] = [];
			if (recordBytes(build()) > MAX_RECORD_BYTES) continue;

			let low = 1;
			let high = values.length;
			let retained = 0;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				summary[field] = values.slice(0, middle);
				if (recordBytes(build()) <= MAX_RECORD_BYTES) {
					retained = middle;
					low = middle + 1;
				} else {
					high = middle - 1;
				}
			}
			summary[field] = values.slice(0, retained);
			record = build();
			if (recordBytes(record) <= MAX_RECORD_BYTES) return finish(record);
		}

		summary.nextRecommendation = undefined;
		record = build();
		if (recordBytes(record) <= MAX_RECORD_BYTES) return finish(record);
		summary.headline = "";
		record = build();
		if (recordBytes(record) <= MAX_RECORD_BYTES) return finish(record);
		worker.lastSummary = undefined;
		record = build();
	}
	if (recordBytes(record) > MAX_RECORD_BYTES) {
		throw new Error("Compact persistence terminal record exceeds the enforced byte budget.");
	}
	return finish(record);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameUsage(left: WorkerUsageStats, right: WorkerUsageStats): boolean {
	return left.turns === right.turns
		&& left.inputTokens === right.inputTokens
		&& left.outputTokens === right.outputTokens
		&& left.cacheReadTokens === right.cacheReadTokens
		&& left.cacheWriteTokens === right.cacheWriteTokens
		&& left.costUsd === right.costUsd
		&& left.contextTokens === right.contextTokens
		&& left.contextWindow === right.contextWindow
		&& left.contextPercent === right.contextPercent
		&& left.contextRemainingTokens === right.contextRemainingTokens;
}

function durableEqual(left: CompactPersistedWorker, right: CompactPersistedWorker): boolean {
	if (left.workerId !== right.workerId
		|| left.profileName !== right.profileName
		|| left.status !== right.status
		|| left.startedAt !== right.startedAt
		|| !sameUsage(left.usage, right.usage)) return false;
	const leftSummary = left.lastSummary;
	const rightSummary = right.lastSummary;
	if (!leftSummary || !rightSummary) return leftSummary === rightSummary;
	return leftSummary.headline === rightSummary.headline
		&& leftSummary.status === rightSummary.status
		&& sameStrings(leftSummary.readFiles, rightSummary.readFiles)
		&& sameStrings(leftSummary.changedFiles, rightSummary.changedFiles)
		&& sameStrings(leftSummary.risks, rightSummary.risks)
		&& leftSummary.nextRecommendation === rightSummary.nextRecommendation;
}

type PendingTransition =
	| {
			record: Extract<TeamPersistenceRecord, { kind: "worker_terminal" }>;
			worker: CompactPersistedWorker;
			detached?: boolean;
	  }
	| { record: Extract<TeamPersistenceRecord, { kind: "worker_pruned" }>; workerId: string };

/** Compact v2 transition journal with append-before-commit semantics. */
export class CompactPersistenceJournal {
	private previousWorkers = new Map<string, CompactPersistedWorker>();
	private observedWorkers = new Map<string, CompactPersistedWorker>();
	private observedSources = new Map<string, CompactPersistedWorker>();
	private observedRecords = new Map<string, Extract<TeamPersistenceRecord, { kind: "worker_terminal" }>>();
	private pending = new Map<string, PendingTransition>();

	constructor(private readonly instrumentation?: CompactPersistenceJournalInstrumentation) {}

	reset(state: PersistedTeamState, config: TeamConfig): void {
		this.previousWorkers.clear();
		this.observedWorkers.clear();
		this.observedSources.clear();
		this.observedRecords.clear();
		this.pending.clear();
		for (const worker of Object.values(state.activeWorkers)) {
			const compact = compactWorker(worker, config);
			this.observedSources.set(worker.workerId, compact);
			if (isPersistableTerminalStatus(worker.status)) {
				const record = terminalRecord(compact, this.instrumentation);
				this.previousWorkers.set(worker.workerId, record.worker);
				this.observedWorkers.set(worker.workerId, record.worker);
				this.observedRecords.set(worker.workerId, record);
			} else {
				this.previousWorkers.set(worker.workerId, compact);
				this.observedWorkers.set(worker.workerId, compact);
			}
		}
	}

	private observeCurrentWorkers(state: PersistedTeamState, config: TeamConfig): void {
		for (const worker of Object.values(state.activeWorkers)) {
			const compact = compactWorker(worker, config);
			const priorSource = this.observedSources.get(worker.workerId);
			if (priorSource
				&& isPersistableTerminalStatus(priorSource.status)
				&& LIVE_WORKER_STATUSES.includes(worker.status)
				&& !isPersistableTerminalStatus(worker.status)) {
				const checkpointWorker = compactWorker({ ...worker, status: "exited" }, config);
				const checkpointRecord = terminalRecord(checkpointWorker, this.instrumentation);
				for (const [pendingId, transition] of this.pending) {
					if ("worker" in transition && transition.worker.workerId === worker.workerId) {
						this.pending.delete(pendingId);
					}
				}
				this.pending.set(checkpointRecord.recordId, {
					record: checkpointRecord,
					worker: checkpointRecord.worker,
					detached: true,
				});
			}
			this.observedSources.set(worker.workerId, compact);
			if (!isPersistableTerminalStatus(worker.status)) {
				this.observedWorkers.set(worker.workerId, compact);
				this.observedRecords.delete(worker.workerId);
				continue;
			}
			if (priorSource
				&& isPersistableTerminalStatus(priorSource.status)
				&& durableEqual(priorSource, compact)
				&& this.observedWorkers.has(worker.workerId)
				&& this.observedRecords.has(worker.workerId)) continue;
			const record = terminalRecord(compact, this.instrumentation);
			this.observedWorkers.set(worker.workerId, record.worker);
			this.observedRecords.set(worker.workerId, record);
		}

		const replacements = new Map<string, PendingTransition>();
		for (const transition of this.pending.values()) {
			if (!("worker" in transition)) {
				replacements.set(transition.record.recordId, transition);
				continue;
			}
			const workerId = transition.worker.workerId;
			const observed = this.observedWorkers.get(workerId);
			const observedRecord = this.observedRecords.get(workerId);
			if (!observed || !isPersistableTerminalStatus(observed.status) || !observedRecord || durableEqual(transition.worker, observed)) {
				replacements.set(transition.record.recordId, transition);
				continue;
			}
			replacements.set(observedRecord.recordId, { record: observedRecord, worker: observedRecord.worker });
		}
		this.pending = replacements;
	}

	prepare(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		// Observation is independent of append success: revisions that arrive while
		// a transition is pending replace its retry payload with the latest canonical state.
		this.observeCurrentWorkers(state, config);
		if (this.pending.size) return [...this.pending.values()].map((transition) => transition.record);

		const currentIds = new Set(Object.keys(state.activeWorkers));
		for (const [workerId, previous] of this.previousWorkers) {
			if (currentIds.has(workerId)) continue;
			const latest = this.observedWorkers.get(workerId) ?? previous;
			const payload = { workerId: latest.workerId, usage: latest.usage, lastEventAt: latest.lastEventAt };
			const record: Extract<TeamPersistenceRecord, { kind: "worker_pruned" }> = {
				version: TEAM_PERSISTENCE_VERSION,
				kind: "worker_pruned",
				recordId: recordId("prune", payload, this.instrumentation),
				workerId: latest.workerId,
				usage: latest.usage,
			};
			if (recordBytes(record) > MAX_RECORD_BYTES) {
				throw new Error("Compact persistence prune record exceeds the enforced byte budget.");
			}
			const inspected = inspectCompactPersistenceRecord(record);
			if (!inspected || inspected.record.kind !== "worker_pruned") {
				throw new Error("Compact persistence prune writer produced an unreadable record.");
			}
			this.pending.set(inspected.record.recordId, {
				record: inspected.record,
				workerId,
			});
		}

		for (const worker of Object.values(state.activeWorkers)) {
			const observed = this.observedWorkers.get(worker.workerId);
			if (!observed) continue;
			const previous = this.previousWorkers.get(worker.workerId);
			if (!isPersistableTerminalStatus(worker.status)) {
				// Runtime-only churn needs no append, but remains the source for a
				// later terminal/prune transition.
				this.previousWorkers.set(worker.workerId, observed);
				continue;
			}
			const record = this.observedRecords.get(worker.workerId);
			if (!record) continue;
			if (previous && isPersistableTerminalStatus(previous.status) && durableEqual(previous, record.worker)) continue;
			this.pending.set(record.recordId, { record, worker: record.worker });
		}
		return [...this.pending.values()].map((transition) => transition.record);
	}

	/**
	 * Stage bounded detached snapshots on the current branch before Pi replaces
	 * the runtime after confirmed tree navigation. This never mutates or cancels
	 * the live workers; cancelled navigation can continue using them.
	 */
	prepareDetachedWorkers(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		this.observeCurrentWorkers(state, config);
		for (const worker of Object.values(state.activeWorkers)) {
			if (!LIVE_WORKER_STATUSES.includes(worker.status)) continue;
			const detached = compactWorker({ ...worker, status: "exited" }, config);
			const record = terminalRecord(detached, this.instrumentation);
			const previous = this.previousWorkers.get(worker.workerId);
			if (previous && isPersistableTerminalStatus(previous.status) && durableEqual(previous, record.worker)) continue;
			this.pending.set(record.recordId, { record, worker: record.worker, detached: true });
		}
		return [...this.pending.values()].map((transition) => transition.record);
	}

	commit(record: TeamPersistenceRecord): void {
		const transition = this.pending.get(record.recordId);
		if (!transition) return;
		if ("worker" in transition) {
			this.previousWorkers.set(transition.worker.workerId, transition.worker);
			if (!transition.detached) {
				this.observedWorkers.set(transition.worker.workerId, transition.worker);
			}
		} else {
			this.previousWorkers.delete(transition.workerId);
			this.observedWorkers.delete(transition.workerId);
			this.observedSources.delete(transition.workerId);
			this.observedRecords.delete(transition.workerId);
		}
		this.pending.delete(record.recordId);
	}

	/** Resolve an append whose Pi leaf advanced before the call threw. */
	resolveAmbiguousAppend(record: TeamPersistenceRecord): void {
		this.commit(record);
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	/** Drop only uncommitted records; used to prevent cross-branch retries. */
	discardPending(): void {
		this.pending.clear();
	}

	/** Compatibility helper for non-I/O callers; append wiring must use prepare/commit. */
	collect(state: PersistedTeamState, config: TeamConfig): TeamPersistenceRecord[] {
		const records = this.prepare(state, config);
		for (const record of records) this.commit(record);
		return records;
	}
}
