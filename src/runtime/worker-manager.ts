import { EventEmitter } from "node:events";
import {
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
import type {
	DelegatedTaskInput,
	ThinkingLevel,
	WorkerExtensionMode,
	WorkerRuntimeState,
	WorkerStatus,
	WorkerSummary,
	WorkerUsageStats,
} from "../types";

export interface LaunchWorkerOptions {
	workerId: string;
	profileName: string;
	task: DelegatedTaskInput;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	systemPromptPath?: string;
	extensionMode?: WorkerExtensionMode;
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

const CONSOLE_BUFFER_LIMIT = 500;
const ASSISTANT_TEXT_BATCH_MS = 400;

interface WorkerRuntimeRecord extends ManagedWorkerRecord {
	textBuffer: string;
	console: WorkerConsoleEvent[];
	pendingTextDelta: string;
	pendingTextFlushAt: number;
	unsubscribers: Array<() => void>;
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

function extractAssistantText(message: Record<string, unknown>): string {
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
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
	return {
		workerId: options.workerId,
		profileName: options.profileName,
		sessionMode: "worker",
		status: "starting",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		currentTask: options.task,
		pendingRelayQuestions: [],
		usage: emptyUsage(),
	};
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
		systemPromptPath: options.systemPromptPath,
		extensionMode: options.extensionMode,
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
		const record: WorkerRuntimeRecord = {
			workerId: options.workerId,
			client,
			handle,
			state: createInitialState(options),
			textBuffer: "",
			console: [],
			pendingTextDelta: "",
			pendingTextFlushAt: 0,
			unsubscribers: [],
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

		handle.waitForExit().then((exitInfo) => {
			const event = createWorkerExitEvent(exitInfo.code, exitInfo.signal, handle.stderrBuffer);
			this.applyNormalizedEvent(record, event);
		});

		await this.refreshState(options.workerId);
		return this.snapshot(options.workerId)!;
	}

	async promptWorker(workerId: string, message: string): Promise<void> {
		const record = this.requireWorker(workerId);
		record.state.status = "running";
		record.state.lastEventAt = Date.now();
		record.state.lastSummary = buildSummary(record.state, record.textBuffer || message);
		this.emitter.emit("event", this.snapshot(workerId), { type: "worker_running", timestamp: record.state.lastEventAt });
		await record.client.prompt(message);
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
		record.state.lastEventAt = Date.now();
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

	private appendConsole(record: WorkerRuntimeRecord, event: WorkerConsoleEvent): void {
		record.console.push(event);
		if (record.console.length > CONSOLE_BUFFER_LIMIT) {
			record.console.splice(0, record.console.length - CONSOLE_BUFFER_LIMIT);
		}
	}

	private flushPendingText(record: WorkerRuntimeRecord): void {
		if (!record.pendingTextDelta) return;
		this.appendConsole(record, {
			ts: record.pendingTextFlushAt || Date.now(),
			kind: "assistant_text",
			text: trimSummary(record.pendingTextDelta, 400),
		});
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
		record.state.lastEventAt = event.timestamp;

		switch (event.type) {
			case "worker_started":
			case "worker_running":
				record.state.status = "running";
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "status", text: "running" });
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
				break;
			case "worker_message": {
				this.flushPendingText(record);
				const assistantText = extractAssistantText(event.message);
				if (assistantText) {
					record.textBuffer = assistantText;
					record.state.pendingRelayQuestions = extractRelayQuestions(assistantText, record.state);
					record.state.lastSummary = buildSummary(record.state, assistantText);
					this.appendConsole(record, {
						ts: event.timestamp,
						kind: "assistant_message",
						text: trimSummary(assistantText, 600),
					});
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
			case "worker_tool_started":
				record.state.status = "running";
				record.state.lastToolName = event.toolName;
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.flushPendingText(record);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "tool_start",
					text: `${event.toolName} ${snippet(event.args, 180)}`.trim(),
				});
				break;
			case "worker_tool_finished":
				record.state.lastToolName = event.toolName;
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "tool_end",
					text: `${event.toolName}${event.isError ? " [error]" : ""} → ${snippet(extractResultText(event.result), 260)}`,
				});
				break;
			case "worker_queue_updated":
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				if (event.steering.length > 0 || event.followUp.length > 0) {
					this.appendConsole(record, {
						ts: event.timestamp,
						kind: "queue",
						text: `steering=${event.steering.length} followUp=${event.followUp.length}`,
					});
				}
				break;
			case "worker_idle":
				record.state.status = record.state.status === "aborted" ? "aborted" : "idle";
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "status", text: record.state.status });
				break;
			case "worker_error":
				record.state.status = "error";
				record.state.error = event.error;
				record.state.lastSummary = buildSummary(record.state, event.error);
				this.flushPendingText(record);
				this.appendConsole(record, { ts: event.timestamp, kind: "error", text: event.error });
				break;
			case "worker_state":
				record.state.status = deriveStatusFromSessionState(event.state);
				record.state.lastSummary = buildSummary(record.state, record.textBuffer);
				break;
			case "worker_exit":
				record.state.status = event.signal === "SIGTERM" ? "aborted" : "exited";
				if (event.code && event.code !== 0) {
					record.state.status = "error";
					record.state.error = event.stderr || `Worker exited with code ${event.code}`;
				}
				record.state.lastSummary = buildSummary(record.state, record.textBuffer || event.stderr || "Worker exited");
				this.flushPendingText(record);
				this.appendConsole(record, {
					ts: event.timestamp,
					kind: "exit",
					text: `status=${record.state.status}${event.code !== null ? ` code=${event.code}` : ""}${event.signal ? ` signal=${event.signal}` : ""}`,
				});
				record.client.dispose(`Worker exited: ${event.code ?? "signal"}`);
				break;
		}

		this.emitter.emit("event", this.snapshot(record.workerId), event);
	}

	private updateUsage(current: WorkerUsageStats, stats: RpcSessionStats): WorkerUsageStats {
		const tokens = stats.tokens;
		return {
			turns: current.turns,
			inputTokens: tokens?.input ?? current.inputTokens,
			outputTokens: tokens?.output ?? current.outputTokens,
			cacheReadTokens: tokens?.cacheRead ?? current.cacheReadTokens,
			cacheWriteTokens: tokens?.cacheWrite ?? current.cacheWriteTokens,
			costUsd: stats.cost ?? current.costUsd,
			contextTokens: stats.contextUsage?.tokens ?? current.contextTokens,
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
