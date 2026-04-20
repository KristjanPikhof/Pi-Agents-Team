import type { RpcEvent, RpcSessionState } from "./rpc-client";

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

export interface WorkerIdleEvent {
	type: "worker_idle";
	messages?: unknown[];
	timestamp: number;
}

export interface WorkerErrorEvent {
	type: "worker_error";
	error: string;
	timestamp: number;
}

export interface WorkerStateEvent {
	type: "worker_state";
	state: RpcSessionState;
	timestamp: number;
}

export interface WorkerExitEvent {
	type: "worker_exit";
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr?: string;
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
	| WorkerIdleEvent
	| WorkerErrorEvent
	| WorkerStateEvent
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
			return [{ type: "worker_idle", messages: Array.isArray(event.messages) ? event.messages : undefined, timestamp: now() }];
		case "extension_error":
			return [
				{
					type: "worker_error",
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

export function createWorkerExitEvent(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr?: string,
): WorkerExitEvent {
	return {
		type: "worker_exit",
		code,
		signal,
		stderr,
		timestamp: now(),
	};
}
