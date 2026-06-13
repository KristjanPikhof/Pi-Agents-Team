import { EventEmitter } from "node:events";
import {
	createThinkingClampedEvent,
	createWorkerExitEvent,
	createWorkerStateEvent,
	normalizeRpcEvent,
	type NormalizedWorkerEvent,
} from "./event-normalizer";
import { RpcClient, type RpcSessionState, type RpcSessionStats } from "./rpc-client";
import {
	spawnWorkerProcess,
	type SpawnWorkerProcess,
	type WorkerProcessHandle,
	type WorkerProcessOptions,
} from "./worker-process";
import { buildWorkerSummaryFromText, extractRelayQuestions } from "../comms/summary";
import { THINKING_LEVELS } from "../types";
import type {
	DelegatedTaskInput,
	ThinkingLevel,
	WorkerExtensionMode,
	WorkerProjectTrustOverride,
	WorkerRuntimeState,
	WorkerStatus,
	WorkerSummary,
	WorkerUsageStats,
} from "../types";

const REUSABLE_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>(["idle", "waiting_followup"]);
const UNREACHABLE_TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
	"completed",
	"aborted",
	"error",
	"exited",
]);

export interface LaunchWorkerOptions {
	workerId: string;
	profileName: string;
	task: DelegatedTaskInput;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	workerExtensions?: string[];
	systemPromptPath?: string;
	extensionMode?: WorkerExtensionMode;
	projectTrust?: WorkerProjectTrustOverride;
	allowSkills?: boolean;
	command?: string;
	baseArgs?: string[];
	extraArgs?: string[];
	env?: NodeJS.ProcessEnv;
}

export interface ManagedWorkerRecord {
	workerId: string;
	client: RpcClient;
	handle: WorkerProcessHandle;
	state: WorkerRuntimeState;
}

export interface WorkerConsoleEvent {
	ts: number;
	kind:
		| "status"
		| "tool_start"
		| "tool_end"
		| "assistant_text"
		| "assistant_message"
		| "queue"
		| "error"
		| "exit";
	text: string;
}

export type WorkerActivityKind = "status" | "command" | "tool" | "process" | "final_summary" | "queue" | "error" | "exit";
export type WorkerActivityStatus = "started" | "completed" | "error" | "info";

export interface WorkerActivityEvent {
	id: string;
	ts: number;
	updatedAt: number;
	actionKind: WorkerActivityKind;
	status: WorkerActivityStatus;
	label: string;
	summary?: string;
	toolName?: string;
	command?: string;
	outputSnippet?: string;
	hiddenLineCount?: number;
	sourceEvent: NormalizedWorkerEvent["type"] | "worker_text_flush";
	toolCallId?: string;
	finalSummaryFields?: {
		headline?: string;
		risks?: string[];
		nextRecommendation?: string;
	};
}

export interface AssistantChunk {
	index: number;
	ts: number;
	text: string;
}

const CONSOLE_BUFFER_LIMIT = 500;
const ACTIVITY_BUFFER_LIMIT = 500;
const TOOL_OUTPUT_ACTIVITY_LINE_LIMIT = 6;
const TOOL_OUTPUT_ACTIVITY_CHAR_LIMIT = 800;
const ASSISTANT_TEXT_BATCH_MS = 400;
// Cap is on the number of buffered text-delta chunks, NOT rendered lines —
// a single chunk may contain newlines. Memory is bounded by the byte cap;
// the chunk cap exists to keep the array from growing unboundedly when each
// chunk is small. Either limit shifts the oldest chunk out.
const ASSISTANT_BUFFER_CHUNK_CAP = 4096;
const ASSISTANT_BUFFER_BYTE_CAP = 256 * 1024;

export interface WorkerLaunchSnapshot {
	cwd: string;
	command?: string;
	baseArgs?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	workerExtensions?: string[];
	systemPromptPath?: string;
	extensionMode?: WorkerExtensionMode;
	projectTrust?: WorkerProjectTrustOverride;
	allowSkills: boolean;
}

interface WorkerRuntimeRecord extends ManagedWorkerRecord {
	textBuffer: string;
	console: WorkerConsoleEvent[];
	activity: WorkerActivityEvent[];
	pendingToolActivityByCallId: Map<string, string>;
	pendingTextDelta: string;
	pendingTextFlushAt: number;
	unsubscribers: Array<() => void>;
	closing: boolean;
	launchSnapshot: WorkerLaunchSnapshot;
	requestedThinkingLevel: ThinkingLevel;
	thinkingClamped: boolean;
	assistantChunks: AssistantChunk[];
	assistantChunkBytes: number;
	assistantNextIndex: number;
}

function emptyUsage(): WorkerUsageStats {
	return {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};
}

function trimSummary(text: string, maxLength = 160): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snippet(value: unknown, maxLength = 200): string {
	if (value === undefined || value === null) return "";
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	return trimSummary(text, maxLength);
}

function extractResultText(result: Record<string, unknown>): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		const pieces = content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string);
		if (pieces.length > 0) return pieces.join("\n");
	}
	return snippet(result);
}

function extractCommand(args: Record<string, unknown>): string | undefined {
	const direct = args.command;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	const cmd = args.cmd;
	if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
	return undefined;
}

function buildOutputSnippet(text: string): { snippet: string; hiddenLineCount: number } {
	const normalized = text.replace(/\r/g, "").trim();
	if (!normalized) return { snippet: "", hiddenLineCount: 0 };
	const lines = normalized.split("\n");
	const visibleLines = lines.slice(0, TOOL_OUTPUT_ACTIVITY_LINE_LIMIT);
	let output = visibleLines.join("\n");
	let hiddenLineCount = Math.max(0, lines.length - visibleLines.length);
	if (Buffer.byteLength(output, "utf8") > TOOL_OUTPUT_ACTIVITY_CHAR_LIMIT) {
		output = trimSummary(output, TOOL_OUTPUT_ACTIVITY_CHAR_LIMIT);
		if (hiddenLineCount === 0 && lines.length > 1) hiddenLineCount = lines.length - 1;
	}
	return { snippet: output, hiddenLineCount };
}

const FINAL_ANSWER_PATTERN = /<final[_\s-]?answer>([\s\S]*?)<\/final[_\s-]?answer>/i;

export function extractFinalAnswer(text: string): string | undefined {
	const match = FINAL_ANSWER_PATTERN.exec(text);
	if (!match) return undefined;
	const content = match[1]?.trim();
	return content && content.length > 0 ? content : undefined;
}

function extractAssistantText(message: Record<string, unknown>): string {
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function extractFinalSummaryFields(finalAnswer: string): WorkerActivityEvent["finalSummaryFields"] {
	const headline = /^headline:\s*(.+)$/im.exec(finalAnswer)?.[1]?.trim();
	const nextRecommendation = /^next_recommendation:\s*(.+)$/im.exec(finalAnswer)?.[1]?.trim();
	const risksBlock = /^risks:\s*$(?<body>(?:\s*[-*]\s+.+\n?)*)/im.exec(finalAnswer)?.groups?.body ?? "";
	const risks = risksBlock
		.split("\n")
		.map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
	return {
		...(headline ? { headline } : {}),
		...(risks.length > 0 ? { risks } : {}),
		...(nextRecommendation ? { nextRecommendation } : {}),
	};
}

function buildFinalSummary(finalAnswer: string): { summary: string; fields: WorkerActivityEvent["finalSummaryFields"] } {
	const fields = extractFinalSummaryFields(finalAnswer);
	const pieces = [fields?.headline, fields?.risks?.[0] ? `Risk: ${fields.risks[0]}` : undefined, fields?.nextRecommendation ? `Next: ${fields.nextRecommendation}` : undefined]
		.filter((value): value is string => Boolean(value));
	return { summary: trimSummary(pieces.length > 0 ? pieces.join(" · ") : finalAnswer, 360), fields };
}

function buildSummary(state: WorkerRuntimeState, text: string): WorkerSummary {
	const summary = buildWorkerSummaryFromText(text || state.currentTask?.title || `${state.profileName}:${state.status}`, state);
	return {
		...summary,
		headline: trimSummary(summary.headline),
		relayQuestionCount: state.pendingRelayQuestions.length,
	};
}

function createInitialState(options: LaunchWorkerOptions): WorkerRuntimeState {
	const requestedThinkingLevel = options.thinkingLevel ?? "medium";
	return {
		workerId: options.workerId,
		profileName: options.profileName,
		sessionMode: "worker",
		status: "starting",
		requestedThinkingLevel,
		effectiveThinkingLevel: requestedThinkingLevel,
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: options.task,
		pendingRelayQuestions: [],
		usage: emptyUsage(),
	};
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function deriveStatusFromSessionState(state: RpcSessionState): WorkerStatus {
	return state.isStreaming ? "running" : "idle";
}

function createWorkerProcessOptions(options: LaunchWorkerOptions): WorkerProcessOptions {
	return {
		cwd: options.cwd,
		command: options.command,
		baseArgs: options.baseArgs,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tools: options.tools,
		workerExtensions: options.workerExtensions,
		systemPromptPath: options.systemPromptPath,
		extensionMode: options.extensionMode,
		projectTrust: options.projectTrust,
		allowSkills: options.allowSkills,
		extraArgs: options.extraArgs,
		env: options.env,
	};
}

export class WorkerManager {
	private readonly workers = new Map<string, WorkerRuntimeRecord>();
	private readonly emitter = new EventEmitter();

	constructor(private readonly spawnProcess: SpawnWorkerProcess = spawnWorkerProcess) {}

	onEvent(listener: (worker: ManagedWorkerRecord, event: NormalizedWorkerEvent) => void): () => void {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	async launchWorker(options: LaunchWorkerOptions): Promise<ManagedWorkerRecord> {
		if (this.workers.has(options.workerId)) {
			throw new Error(`Worker already exists: ${options.workerId}`);
		}

		const handle = this.spawnProcess(createWorkerProcessOptions(options));
		const client = new RpcClient(handle.transport);
		const requestedThinkingLevel = options.thinkingLevel ?? "medium";
		const record: WorkerRuntimeRecord = {
			workerId: options.workerId,
			client,
			handle,
			state: createInitialState(options),
			textBuffer: "",
			console: [],
			activity: [],
			pendingToolActivityByCallId: new Map(),
			pendingTextDelta: "",
			pendingTextFlushAt: 0,
			unsubscribers: [],
			closing: false,
			requestedThinkingLevel,
			thinkingClamped: false,
			assistantChunks: [],
			assistantChunkBytes: 0,
			assistantNextIndex: 0,
			launchSnapshot: {
				cwd: options.cwd,
				command: options.command,
				baseArgs: options.baseArgs ? [...options.baseArgs] : undefined,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				tools: options.tools ? [...options.tools] : undefined,
				workerExtensions: options.workerExtensions ? [...options.workerExtensions] : undefined,
				systemPromptPath: options.systemPromptPath,
				extensionMode: options.extensionMode,
				projectTrust: options.projectTrust,
				allowSkills: options.allowSkills === true,
			},
		};
		this.workers.set(options.workerId, record);

		record.unsubscribers.push(
			client.onEvent((event) => {
				for (const normalizedEvent of normalizeRpcEvent(event)) {
					this.applyNormalizedEvent(record, normalizedEvent);
				}
			}),
		);
		record.unsubscribers.push(
			client.onError((error) => {
				const normalizedEvent: NormalizedWorkerEvent = {
					type: "worker_error",
					error: error.message,
					timestamp: Date.now(),
				};
				this.applyNormalizedEvent(record, normalizedEvent);
			}),
		);

		let launchCommitted = false;
		const exitPromise = handle.waitForExit().then((exitInfo) => {
			if (launchCommitted) {
				const event = createWorkerExitEvent(exitInfo.code, exitInfo.signal, handle.stderrBuffer, exitInfo.error?.message);
				this.applyNormalizedEvent(record, event);
			}
			return exitInfo;
		});

		try {
			const state = await Promise.race([
				this.refreshState(options.workerId),
				exitPromise.then((exitInfo) => {
					throw exitInfo.error ?? new Error("Worker exited before launch completed");
				}),
			]);
			launchCommitted = true;
			this.detectThinkingClamp(record, state);
			return this.snapshot(options.workerId)!;
		} catch (error) {
			for (const off of record.unsubscribers) off();
			record.client.dispose("Worker launch failed");
			this.workers.delete(options.workerId);
			try {
				await handle.dispose();
			} catch {
				// Best-effort cleanup after launch failure.
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			throw new Error(`Worker launch failed for ${options.workerId}: ${errorMessage}`);
		}
	}

	hasWorker(workerId: string): boolean {
		return this.workers.has(workerId);
	}

	getLaunchSnapshot(workerId: string): WorkerLaunchSnapshot | undefined {
		const record = this.workers.get(workerId);
		return record ? {
			...record.launchSnapshot,
			baseArgs: record.launchSnapshot.baseArgs ? [...record.launchSnapshot.baseArgs] : undefined,
			tools: record.launchSnapshot.tools ? [...record.launchSnapshot.tools] : undefined,
			workerExtensions: record.launchSnapshot.workerExtensions ? [...record.launchSnapshot.workerExtensions] : undefined,
		} : undefined;
	}

	async removeWorker(workerId: string): Promise<void> {
		const record = this.workers.get(workerId);
		if (!record) return;
		if (REUSABLE_STATUSES.has(record.state.status)) {
			try {
				await this.closeWorker(workerId, "Worker auto-closed on removal.");
			} catch {
				// Best-effort: still drop the map entry below.
			}
		}
		for (const off of record.unsubscribers) off();
		record.client.dispose("Worker removed");
		this.workers.delete(workerId);
	}

	async reuseWorker(workerId: string, message: string, task: DelegatedTaskInput): Promise<void> {
		const record = this.requireWorker(workerId);
		if (!REUSABLE_STATUSES.has(record.state.status)) {
			throw new Error(
				`Worker ${workerId} cannot be reused (status=${record.state.status}). Only idle and waiting_followup workers retain a live RPC session.`,
			);
		}
		record.state.currentTask = task;
		record.state.finalAnswer = undefined;
		record.state.lastToolName = undefined;
		record.state.pendingRelayQuestions = [];
		record.state.lastSummary = undefined;
		record.state.error = undefined;
		record.textBuffer = "";
		record.pendingTextDelta = "";
		record.pendingTextFlushAt = 0;
		record.activity = [];
		record.pendingToolActivityByCallId = new Map();
		record.assistantChunks = [];
		record.assistantChunkBytes = 0;
		record.assistantNextIndex = 0;
		// Reuse keeps the same RPC session and launch-time model/thinking flags,
		// so the post-launch clamp comparison remains valid for the reused task.
		await this.promptWorker(workerId, message);
	}

	async closeWorker(workerId: string, reason = "Worker closed by operator."): Promise<void> {
		const record = this.requireWorker(workerId);
		if (!REUSABLE_STATUSES.has(record.state.status)) {
			throw new Error(
				`Worker ${workerId} cannot be closed (status=${record.state.status}). Only idle and waiting_followup workers can be closed; running workers need /team-stop.`,
			);
		}
		record.closing = true;
		record.state.error = reason;
		await record.handle.dispose();
	}

	async promptWorker(workerId: string, message: string): Promise<void> {
		const record = this.requireWorker(workerId);
		record.state.status = "running";
		record.state.lastEventAt = Date.now();
		record.state.lastSummary = buildSummary(record.state, record.textBuffer || message);
		this.emitter.emit("event", this.snapshot(workerId), { type: "worker_running", timestamp: record.state.lastEventAt });
		try {
			await record.client.prompt(message);
		} catch (error) {
			const timestamp = Date.now();
			const errorMessage = error instanceof Error ? error.message : String(error);
			record.state.status = "error";
			record.state.error = errorMessage;
			record.state.lastEventAt = timestamp;
			record.state.lastSummary = buildSummary(record.state, errorMessage);
			this.flushPendingText(record);
			this.appendConsole(record, { ts: timestamp, kind: "error", text: errorMessage });
			this.emitter.emit("event", this.snapshot(workerId), {
				type: "worker_error",
				error: errorMessage,
				timestamp,
			});
			throw error;
		}
	}

	async steerWorker(workerId: string, message: string): Promise<void> {
		const record = this.requireWorker(workerId);
		await record.client.steer(message);
	}

	async followUpWorker(workerId: string, message: string): Promise<void> {
		const record = this.requireWorker(workerId);
		await record.client.followUp(message);
	}

	async abortWorker(workerId: string): Promise<void> {
		const record = this.requireWorker(workerId);
		await record.client.abort();
		record.state.status = "aborted";
		record.state.lastSummary = buildSummary(record.state, record.textBuffer || "Aborted");
	}

	async refreshState(workerId: string): Promise<RpcSessionState> {
		const record = this.requireWorker(workerId);
		const state = await record.client.getState();
		this.applyNormalizedEvent(record, createWorkerStateEvent(state));
		return state;
	}

	async refreshStats(workerId: string): Promise<RpcSessionStats> {
		const record = this.requireWorker(workerId);
		const stats = await record.client.getSessionStats();
		record.state.usage = this.updateUsage(record.state.usage, stats);
		record.state.lastSummary = buildSummary(record.state, record.textBuffer);
		return stats;
	}

	getWorker(workerId: string): ManagedWorkerRecord | undefined {
		return this.snapshot(workerId);
	}

	getWorkerTranscript(workerId: string): string | undefined {
		return this.workers.get(workerId)?.textBuffer;
	}

	getWorkerConsole(workerId: string): WorkerConsoleEvent[] | undefined {
		const record = this.workers.get(workerId);
		if (!record) return undefined;
		this.flushPendingText(record);
		return record.console.slice();
	}

	getWorkerActivity(workerId: string): WorkerActivityEvent[] | undefined {
		const record = this.workers.get(workerId);
		if (!record) return undefined;
		this.flushPendingText(record);
		return structuredClone(record.activity);
	}

	getAssistantTail(workerId: string, fromIndex?: number): AssistantChunk[] {
		const record = this.workers.get(workerId);
		if (!record) return [];
		if (fromIndex === undefined) return record.assistantChunks.slice();
		return record.assistantChunks.filter((chunk) => chunk.index >= fromIndex);
	}

	onAssistantChunk(listener: (workerId: string, chunk: AssistantChunk) => void): () => void {
		this.emitter.on("assistant_chunk", listener);
		return () => this.emitter.off("assistant_chunk", listener);
	}

	onActivityEvent(listener: (workerId: string, event: WorkerActivityEvent) => void): () => void {
		this.emitter.on("activity_event", listener);
		return () => this.emitter.off("activity_event", listener);
	}

	private appendAssistantChunk(record: WorkerRuntimeRecord, ts: number, text: string): void {
		if (!text) return;
		const chunk: AssistantChunk = { index: record.assistantNextIndex, ts, text };
		record.assistantNextIndex += 1;
		record.assistantChunks.push(chunk);
		record.assistantChunkBytes += Buffer.byteLength(text, "utf8");
		// Keep at least one chunk even if it overshoots the byte cap; otherwise a
		// single oversized delta would self-evict and leave the live tail empty.
		while (
			record.assistantChunks.length > 1
			&& (record.assistantChunks.length > ASSISTANT_BUFFER_CHUNK_CAP
				|| record.assistantChunkBytes > ASSISTANT_BUFFER_BYTE_CAP)
		) {
			const dropped = record.assistantChunks.shift();
			if (!dropped) break;
			record.assistantChunkBytes -= Buffer.byteLength(dropped.text, "utf8");
		}
		this.emitter.emit("assistant_chunk", record.workerId, chunk);
	}

	private appendConsole(record: WorkerRuntimeRecord, event: WorkerConsoleEvent): void {
		record.console.push(event);
		if (record.console.length > CONSOLE_BUFFER_LIMIT) {
			record.console.splice(0, record.console.length - CONSOLE_BUFFER_LIMIT);
		}
	}

	private appendActivity(record: WorkerRuntimeRecord, event: WorkerActivityEvent): void {
		record.activity.push(event);
		if (record.activity.length > ACTIVITY_BUFFER_LIMIT) {
			record.activity.splice(0, record.activity.length - ACTIVITY_BUFFER_LIMIT);
		}
		this.emitter.emit("activity_event", record.workerId, structuredClone(event));
	}

	private updateActivity(record: WorkerRuntimeRecord, activityId: string, patch: Partial<WorkerActivityEvent>): void {
		const activity = record.activity.find((item) => item.id === activityId);
		if (!activity) return;
		Object.assign(activity, patch);
		this.emitter.emit("activity_event", record.workerId, structuredClone(activity));
	}

	private nextActivityId(record: WorkerRuntimeRecord, sourceEvent: WorkerActivityEvent["sourceEvent"], timestamp: number): string {
		return `${record.workerId}:${sourceEvent}:${timestamp}:${record.activity.length}`;
	}

	private flushPendingText(record: WorkerRuntimeRecord): void {
		if (!record.pendingTextDelta) return;
		const ts = record.pendingTextFlushAt || Date.now();
		const pendingText = record.pendingTextDelta;
		const text = trimSummary(pendingText, 400);
		this.appendConsole(record, {
			ts,
			kind: "assistant_text",
			text,
		});
		const finalAnswer = extractFinalAnswer(pendingText);
		if (finalAnswer) {
			const finalSummary = buildFinalSummary(finalAnswer);
			this.appendActivity(record, {
				id: this.nextActivityId(record, "worker_text_flush", ts),
				ts,
				updatedAt: ts,
				actionKind: "final_summary",
				status: "completed",
				label: "Final answer",
				summary: finalSummary.summary,
				sourceEvent: "worker_text_flush",
				finalSummaryFields: finalSummary.fields,
			});
		} else if (!/<final[_\s-]?answer\b|<\/final[_\s-]?answer>/i.test(pendingText)) {
			this.appendActivity(record, {
				id: this.nextActivityId(record, "worker_text_flush", ts),
				ts,
				updatedAt: ts,
				actionKind: "process",
				status: "info",
				label: "Thinking",
				summary: trimSummary(text, 260),
				sourceEvent: "worker_text_flush",
			});
		}
		record.pendingTextDelta = "";
		record.pendingTextFlushAt = 0;
	}

	listWorkers(): ManagedWorkerRecord[] {
		return Array.from(this.workers.keys())
			.map((workerId) => this.snapshot(workerId))
			.filter((worker): worker is ManagedWorkerRecord => worker !== undefined);
	}

	async shutdownWorker(workerId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		const record = this.requireWorker(workerId);
		await record.handle.dispose(signal);
	}

	async dispose(): Promise<void> {
		for (const workerId of Array.from(this.workers.keys())) {
			await this.shutdownWorker(workerId);
		}
	}

	private applyNormalizedEvent(record: WorkerRuntimeRecord, event: NormalizedWorkerEvent): void {
		if (event.type !== "worker_state") {
			record.state.lastEventAt = event.timestamp;
		}

		switch (event.type) {
			case "worker_started":
			case "worker_running":
				record.state.status = "running";
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "status", text: "running" });
				this.appendActivity(record, {
					id: this.nextActivityId(record, event.type, event.timestamp),
					ts: event.timestamp,
					updatedAt: event.timestamp,
					actionKind: "status",
					status: "info",
					label: "Worker running",
					summary: "running",
					sourceEvent: event.type,
				});
				break;
			case "worker_text_delta":
				record.textBuffer += event.delta;
				record.state.status = "running";
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				record.pendingTextDelta += event.delta;
				record.pendingTextFlushAt = record.pendingTextFlushAt || event.timestamp;
				if (event.timestamp - record.pendingTextFlushAt >= ASSISTANT_TEXT_BATCH_MS || record.pendingTextDelta.length > 320) {
					this.flushPendingText(record);
				}
				this.appendAssistantChunk(record, event.timestamp, event.delta);
				break;
			case "worker_message": {
				this.flushPendingText(record);
				const assistantText = extractAssistantText(event.message);
				if (assistantText) {
					record.textBuffer = assistantText;
					const finalAnswer = extractFinalAnswer(assistantText);
					if (finalAnswer) {
						record.state.finalAnswer = finalAnswer;
					}
					record.state.pendingRelayQuestions = extractRelayQuestions(assistantText, record.state);
					record.state.lastSummary = buildSummary(record.state, assistantText);
					this.appendConsole(record, {
						ts: event.timestamp,
						kind: "assistant_message",
						text: trimSummary(finalAnswer ?? assistantText, 600),
					});
					if (finalAnswer) {
						const finalSummary = buildFinalSummary(finalAnswer);
						this.appendActivity(record, {
							id: this.nextActivityId(record, event.type, event.timestamp),
							ts: event.timestamp,
							updatedAt: event.timestamp,
							actionKind: "final_summary",
							status: "completed",
							label: "Final answer",
							summary: finalSummary.summary,
							sourceEvent: event.type,
							finalSummaryFields: finalSummary.fields,
						});
					} else {
						this.appendActivity(record, {
							id: this.nextActivityId(record, event.type, event.timestamp),
							ts: event.timestamp,
							updatedAt: event.timestamp,
							actionKind: "process",
							status: "info",
							label: "Assistant message",
							summary: trimSummary(assistantText, 260),
							sourceEvent: event.type,
						});
					}
				}
				const messageUsage = event.message.usage as Record<string, unknown> | undefined;
				if (messageUsage) {
					record.state.usage.inputTokens += Number(messageUsage.input ?? 0);
					record.state.usage.outputTokens += Number(messageUsage.output ?? 0);
					record.state.usage.cacheReadTokens += Number(messageUsage.cacheRead ?? 0);
					record.state.usage.cacheWriteTokens += Number(messageUsage.cacheWrite ?? 0);
					record.state.usage.contextTokens = Number(messageUsage.totalTokens ?? 0) || undefined;
					const cost = messageUsage.cost as Record<string, unknown> | undefined;
					record.state.usage.costUsd += Number(cost?.total ?? 0);
					record.state.usage.turns += 1;
				}
				break;
			}
			case "worker_tool_started": {
				record.state.status = "running";
				record.state.lastToolName = event.toolName;
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.flushPendingText(record);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "tool_start",
					text: `${event.toolName} ${snippet(event.args, 180)}`.trim(),
				});
				const command = extractCommand(event.args);
				const isCommand = event.toolName === "bash" || event.toolName === "shell" || command !== undefined;
				const activityId = this.nextActivityId(record, event.type, event.timestamp);
				if (event.toolCallId) record.pendingToolActivityByCallId.set(event.toolCallId, activityId);
				this.appendActivity(record, {
					id: activityId,
					ts: event.timestamp,
					updatedAt: event.timestamp,
					actionKind: isCommand ? "command" : "tool",
					status: "started",
					label: isCommand ? `Ran ${command ?? event.toolName}` : `Used ${event.toolName || "tool"}`,
					summary: command ? trimSummary(command, 220) : snippet(event.args, 220),
					toolName: event.toolName,
					...(command ? { command } : {}),
					sourceEvent: event.type,
					toolCallId: event.toolCallId || undefined,
				});
				break;
			}
			case "worker_tool_finished": {
				record.state.lastToolName = event.toolName;
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "tool_end",
					text: `${event.toolName}${event.isError ? " [error]" : ""} → ${snippet(extractResultText(event.result), 260)}`,
				});
				const resultText = extractResultText(event.result);
				const output = buildOutputSnippet(resultText);
				const pendingId = event.toolCallId ? record.pendingToolActivityByCallId.get(event.toolCallId) : undefined;
				if (pendingId) {
					record.pendingToolActivityByCallId.delete(event.toolCallId);
					this.updateActivity(record, pendingId, {
						updatedAt: event.timestamp,
						status: event.isError ? "error" : "completed",
						toolName: event.toolName,
						...(output.snippet ? { outputSnippet: output.snippet } : {}),
						...(output.hiddenLineCount > 0 ? { hiddenLineCount: output.hiddenLineCount } : {}),
						sourceEvent: event.type,
					});
				} else {
					this.appendActivity(record, {
						id: this.nextActivityId(record, event.type, event.timestamp),
						ts: event.timestamp,
						updatedAt: event.timestamp,
						actionKind: "tool",
						status: event.isError ? "error" : "completed",
						label: `${event.toolName || "Tool"} finished`,
						toolName: event.toolName,
						...(output.snippet ? { outputSnippet: output.snippet } : {}),
						...(output.hiddenLineCount > 0 ? { hiddenLineCount: output.hiddenLineCount } : {}),
						sourceEvent: event.type,
						toolCallId: event.toolCallId || undefined,
					});
				}
				break;
			}
			case "worker_queue_updated":
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				if (event.steering.length > 0 || event.followUp.length > 0) {
					this.appendConsole(record, {
						ts: event.timestamp,
						kind: "queue",
						text: `steering=${event.steering.length} followUp=${event.followUp.length}`,
					});
					this.appendActivity(record, {
						id: this.nextActivityId(record, event.type, event.timestamp),
						ts: event.timestamp,
						updatedAt: event.timestamp,
						actionKind: "queue",
						status: "info",
						label: "Messages queued",
						summary: `steering=${event.steering.length} followUp=${event.followUp.length}`,
						sourceEvent: event.type,
					});
				}
				break;
			case "worker_idle":
				record.state.status = record.state.status === "aborted" ? "aborted" : "idle";
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "status", text: record.state.status });
				this.appendActivity(record, {
					id: this.nextActivityId(record, event.type, event.timestamp),
					ts: event.timestamp,
					updatedAt: event.timestamp,
					actionKind: "status",
					status: "info",
					label: "Worker idle",
					summary: record.state.status,
					sourceEvent: event.type,
				});
				break;
			case "worker_error":
				record.state.status = "error";
				record.state.error = event.error;
				record.state.lastSummary = buildSummary(record.state, event.error);
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "error", text: event.error });
				this.appendActivity(record, {
					id: this.nextActivityId(record, event.type, event.timestamp),
					ts: event.timestamp,
					updatedAt: event.timestamp,
					actionKind: "error",
					status: "error",
					label: "Worker error",
					summary: trimSummary(event.error, 260),
					sourceEvent: event.type,
				});
				break;
			case "worker_state": {
				if (isThinkingLevel(event.state.thinkingLevel)) {
					record.state.effectiveThinkingLevel = event.state.thinkingLevel;
				}
				if (record.state.status === "starting" && !event.state.isStreaming) {
					break;
				}
				if (UNREACHABLE_TERMINAL_STATUSES.has(record.state.status)) {
					break;
				}
				const previousStatus = record.state.status;
				record.state.status = deriveStatusFromSessionState(event.state);
				if (record.state.status !== previousStatus) {
					record.state.lastEventAt = event.timestamp;
				}
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				break;
			}
			case "thinking_clamped":
				break;
			case "worker_exit":
				if (record.closing) {
					record.state.status = "exited";
				} else if (event.error) {
					record.state.status = "error";
					record.state.error = event.error;
				} else {
					record.state.status = event.signal === "SIGTERM" ? "aborted" : "exited";
					if (event.code && event.code !== 0) {
						record.state.status = "error";
						record.state.error = event.stderr || `Worker exited with code ${event.code}`;
					}
				}
				record.state.lastSummary = buildSummary(record.state, record.textBuffer || event.stderr || "Worker exited");
				this.flushPendingText(record);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "exit",
					text: `status=${record.state.status}${event.code !== null ? ` code=${event.code}` : ""}${event.signal ? ` signal=${event.signal}` : ""}`,
				});
				this.appendActivity(record, {
					id: this.nextActivityId(record, event.type, event.timestamp),
					ts: event.timestamp,
					updatedAt: event.timestamp,
					actionKind: "exit",
					status: record.state.status === "error" ? "error" : "completed",
					label: "Worker exited",
					summary: `status=${record.state.status}${event.code !== null ? ` code=${event.code}` : ""}${event.signal ? ` signal=${event.signal}` : ""}`,
					sourceEvent: event.type,
				});
				record.client.dispose(`Worker exited: ${event.code ?? "signal"}`);
				break;
		}

		this.emitter.emit("event", this.snapshot(record.workerId), event);
	}

	private detectThinkingClamp(record: WorkerRuntimeRecord, state: RpcSessionState): void {
		if (!isThinkingLevel(state.thinkingLevel)) return;
		record.state.effectiveThinkingLevel = state.thinkingLevel;
		if (record.requestedThinkingLevel === record.state.effectiveThinkingLevel) return;

		record.thinkingClamped = true;
		this.applyNormalizedEvent(
			record,
			createThinkingClampedEvent({
				workerId: record.workerId,
				profileName: record.state.profileName,
				modelLabel: record.launchSnapshot.model ?? "default",
				requested: record.requestedThinkingLevel,
				effective: record.state.effectiveThinkingLevel,
			}),
		);
	}

	private updateUsage(current: WorkerUsageStats, stats: RpcSessionStats): WorkerUsageStats {
		const tokens = stats.tokens;
		const contextUsage = stats.contextUsage;
		const contextTokens = contextUsage ? finiteNumber(contextUsage.tokens) : current.contextTokens;
		const contextWindow = contextUsage ? finiteNumber(contextUsage.contextWindow) : undefined;
		const contextPercent = contextUsage ? finiteNumber(contextUsage.percent) : undefined;
		const contextRemainingTokens = contextUsage
			? contextTokens !== undefined && contextWindow !== undefined
				? Math.max(0, contextWindow - contextTokens)
				: undefined
			: undefined;

		return {
			turns: current.turns,
			inputTokens: tokens?.input ?? current.inputTokens,
			outputTokens: tokens?.output ?? current.outputTokens,
			cacheReadTokens: tokens?.cacheRead ?? current.cacheReadTokens,
			cacheWriteTokens: tokens?.cacheWrite ?? current.cacheWriteTokens,
			costUsd: stats.cost ?? current.costUsd,
			contextTokens,
			contextWindow,
			contextPercent,
			contextRemainingTokens,
		};
	}

	private requireWorker(workerId: string): WorkerRuntimeRecord {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker: ${workerId}`);
		}
		return worker;
	}

	private snapshot(workerId: string): ManagedWorkerRecord | undefined {
		const record = this.workers.get(workerId);
		if (!record) return undefined;
		return {
			workerId: record.workerId,
			client: record.client,
			handle: record.handle,
			state: structuredClone(record.state),
		};
	}
}
