import type { RpcEvent, RpcSessionState } from "./rpc-client.js";
import type { ThinkingLevel } from "../types.js";

export interface WorkerStartedEvent {
	type: "worker_started";
	timestamp: number;
}

export interface WorkerRunningEvent {
	type: "worker_running";
	timestamp: number;
}

export interface WorkerTextDeltaEvent {
	type: "worker_text_delta";
	delta: string;
	timestamp: number;
}

export interface WorkerMessageEvent {
	type: "worker_message";
	message: Record<string, unknown>;
	timestamp: number;
}

export interface WorkerToolStartedEvent {
	type: "worker_tool_started";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	timestamp: number;
}

export interface WorkerToolFinishedEvent {
	type: "worker_tool_finished";
	toolCallId: string;
	toolName: string;
	result: Record<string, unknown>;
	isError: boolean;
	timestamp: number;
}

export interface WorkerQueueUpdatedEvent {
	type: "worker_queue_updated";
	steering: string[];
	followUp: string[];
	timestamp: number;
}

export interface WorkerAgentEndEvent {
	type: "worker_agent_end";
	messages?: unknown[];
	timestamp: number;
}

export interface WorkerSummarizationRetryScheduledEvent {
	type: "worker_summarization_retry_scheduled";
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	timestamp: number;
}

export interface WorkerSummarizationRetryAttemptStartedEvent {
	type: "worker_summarization_retry_attempt_started";
	source?: "compaction" | "branchSummary";
	reason?: "manual" | "threshold" | "overflow";
	timestamp: number;
}

export interface WorkerSummarizationRetryFinishedEvent {
	type: "worker_summarization_retry_finished";
	timestamp: number;
}

export interface WorkerIdleEvent {
	type: "worker_idle";
	timestamp: number;
}

export interface WorkerErrorEvent {
	type: "worker_error";
	error: string;
	timestamp: number;
}

export interface WorkerExtensionErrorEvent {
	type: "worker_extension_error";
	error: string;
	timestamp: number;
}

export interface WorkerStateEvent {
	type: "worker_state";
	state: RpcSessionState;
	timestamp: number;
}

export interface WorkerThinkingClampedEvent {
	type: "thinking_clamped";
	workerId: string;
	profileName: string;
	modelLabel: string;
	requested: ThinkingLevel;
	effective: ThinkingLevel;
	timestamp: number;
}

export interface WorkerExitEvent {
	type: "worker_exit";
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr?: string;
	error?: string;
	timestamp: number;
}

export type NormalizedWorkerEvent =
	| WorkerStartedEvent
	| WorkerRunningEvent
	| WorkerTextDeltaEvent
	| WorkerMessageEvent
	| WorkerToolStartedEvent
	| WorkerToolFinishedEvent
	| WorkerQueueUpdatedEvent
	| WorkerAgentEndEvent
	| WorkerSummarizationRetryScheduledEvent
	| WorkerSummarizationRetryAttemptStartedEvent
	| WorkerSummarizationRetryFinishedEvent
	| WorkerIdleEvent
	| WorkerErrorEvent
	| WorkerExtensionErrorEvent
	| WorkerStateEvent
	| WorkerThinkingClampedEvent
	| WorkerExitEvent;

function now(): number {
	return Date.now();
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeRpcEvent(event: RpcEvent): NormalizedWorkerEvent[] {
	switch (event.type) {
		case "agent_start":
			return [
				{ type: "worker_started", timestamp: now() },
				{ type: "worker_running", timestamp: now() },
			];
		case "message_update": {
			const assistantMessageEvent = asRecord(event.assistantMessageEvent);
			if (assistantMessageEvent.type !== "text_delta") return [];
			const delta = assistantMessageEvent.delta;
			return typeof delta === "string" ? [{ type: "worker_text_delta", delta, timestamp: now() }] : [];
		}
		case "message_end": {
			const message = asRecord(event.message);
			return Object.keys(message).length > 0 ? [{ type: "worker_message", message, timestamp: now() }] : [];
		}
		case "tool_execution_start":
			return [
				{
					type: "worker_tool_started",
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
					toolName: typeof event.toolName === "string" ? event.toolName : "",
					args: asRecord(event.args),
					timestamp: now(),
				},
			];
		case "tool_execution_end":
			return [
				{
					type: "worker_tool_finished",
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
					toolName: typeof event.toolName === "string" ? event.toolName : "",
					result: asRecord(event.result),
					isError: event.isError === true,
					timestamp: now(),
				},
			];
		case "queue_update":
			return [
				{
					type: "worker_queue_updated",
					steering: asStringArray(event.steering),
					followUp: asStringArray(event.followUp),
					timestamp: now(),
				},
			];
		case "agent_end":
			return [{ type: "worker_agent_end", messages: Array.isArray(event.messages) ? event.messages : undefined, timestamp: now() }];
		case "summarization_retry_scheduled":
			return [{
				type: "worker_summarization_retry_scheduled",
				attempt: asFiniteNumber(event.attempt),
				maxAttempts: asFiniteNumber(event.maxAttempts),
				delayMs: asFiniteNumber(event.delayMs),
				errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
				timestamp: now(),
			}];
		case "summarization_retry_attempt_start": {
			const source = event.source === "compaction" || event.source === "branchSummary" ? event.source : undefined;
			const reason = source === "compaction"
				&& (event.reason === "manual" || event.reason === "threshold" || event.reason === "overflow")
				? event.reason
				: undefined;
			return [{
				type: "worker_summarization_retry_attempt_started",
				source,
				reason,
				timestamp: now(),
			}];
		}
		case "summarization_retry_finished":
			return [{ type: "worker_summarization_retry_finished", timestamp: now() }];
		case "agent_settled":
			return [{ type: "worker_idle", timestamp: now() }];
		case "extension_error":
			return [
				{
					type: "worker_extension_error",
					error: typeof event.error === "string" ? event.error : "Unknown extension error",
					timestamp: now(),
				},
			];
		default:
			return [];
	}
}

export function createWorkerStateEvent(state: RpcSessionState): WorkerStateEvent {
	return {
		type: "worker_state",
		state,
		timestamp: now(),
	};
}

export function createThinkingClampedEvent(options: {
	workerId: string;
	profileName: string;
	modelLabel: string;
	requested: ThinkingLevel;
	effective: ThinkingLevel;
}): WorkerThinkingClampedEvent {
	return {
		type: "thinking_clamped",
		workerId: options.workerId,
		profileName: options.profileName,
		modelLabel: options.modelLabel,
		requested: options.requested,
		effective: options.effective,
		timestamp: now(),
	};
}

export function createWorkerExitEvent(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr?: string,
	error?: string,
): WorkerExitEvent {
	return {
		type: "worker_exit",
		code,
		signal,
		stderr,
		error,
		timestamp: now(),
	};
}
