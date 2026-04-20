import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

export interface RpcCommandBase {
	type: string;
	id?: string;
}

export interface RpcResponse<TData = unknown> {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: TData;
	error?: string;
}

export type RpcEvent = Record<string, unknown> & { type: string };

export interface RpcSessionState {
	model: unknown;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: string;
	followUpMode: string;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface RpcSessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost?: number;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

export interface RpcTransport {
	stdin: Writable;
	stdout: Readable;
	stderr?: Readable;
}

interface Deferred<TValue> {
	resolve: (value: TValue) => void;
	reject: (error: Error) => void;
}

function isRpcResponse(record: RpcEvent | RpcResponse): record is RpcResponse {
	return record.type === "response" && "command" in record && "success" in record;
}

export interface PromptRpcCommand extends RpcCommandBase {
	type: "prompt";
	message: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface SimpleMessageRpcCommand extends RpcCommandBase {
	type: "steer" | "follow_up" | "abort" | "get_state" | "get_messages" | "get_session_stats";
	message?: string;
}

export type SupportedRpcCommand = PromptRpcCommand | SimpleMessageRpcCommand;

export class StrictJsonlParser {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	constructor(
		private readonly onRecord: (record: RpcEvent | RpcResponse) => void,
		private readonly onError: (error: Error, line: string) => void,
	) {}

	push(chunk: string | Buffer): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.flushCompleteLines();
	}

	end(): void {
		this.buffer += this.decoder.end();
		this.flushCompleteLines();
		if (!this.buffer.trim()) {
			this.buffer = "";
			return;
		}

		const line = this.normalizeLine(this.buffer);
		this.buffer = "";
		this.parseLine(line);
	}

	private flushCompleteLines(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;

			const rawLine = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.parseLine(this.normalizeLine(rawLine));
		}
	}

	private normalizeLine(line: string): string {
		return line.endsWith("\r") ? line.slice(0, -1) : line;
	}

	private parseLine(line: string): void {
		if (!line.trim()) return;
		try {
			this.onRecord(JSON.parse(line) as RpcEvent | RpcResponse);
		} catch (error) {
			this.onError(error instanceof Error ? error : new Error(String(error)), line);
		}
	}
}

export class RpcClient {
	private readonly emitter = new EventEmitter();
	private readonly pending = new Map<string, Deferred<any>>();
	private readonly parser: StrictJsonlParser;
	private requestCounter = 0;
	private disposed = false;

	constructor(private readonly transport: RpcTransport) {
		this.parser = new StrictJsonlParser(
			(record) => this.handleRecord(record),
			(error, line) => this.handleParseError(error, line),
		);

		this.transport.stdout.on("data", this.handleStdoutData);
		this.transport.stdout.on("end", this.handleStdoutEnd);
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.emitter.on("error", listener);
		return () => this.emitter.off("error", listener);
	}

	async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
		await this.send<void>({
			type: "prompt",
			message,
			...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
		});
	}

	async steer(message: string): Promise<void> {
		await this.send<void>({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.send<void>({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.send<void>({ type: "abort" });
	}

	async getState(): Promise<RpcSessionState> {
		return this.send<RpcSessionState>({ type: "get_state" });
	}

	async getMessages(): Promise<unknown> {
		return this.send<unknown>({ type: "get_messages" });
	}

	async getSessionStats(): Promise<RpcSessionStats> {
		return this.send<RpcSessionStats>({ type: "get_session_stats" });
	}

	async send<TData>(command: SupportedRpcCommand, signal?: AbortSignal): Promise<TData> {
		if (this.disposed) {
			throw new Error("RPC client has been disposed");
		}

		const id = command.id ?? this.nextId();
		const payload = { ...command, id };
		const body = `${JSON.stringify(payload)}\n`;

		return new Promise<TData>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });

			const onAbort = (): void => {
				this.pending.delete(id);
				reject(new Error(`RPC command aborted: ${command.type}`));
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			this.transport.stdin.write(body, (error) => {
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
				if (!error) return;
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	dispose(reason = "RPC client disposed"): void {
		if (this.disposed) return;
		this.disposed = true;
		this.transport.stdout.off("data", this.handleStdoutData);
		this.transport.stdout.off("end", this.handleStdoutEnd);
		this.parser.end();
		this.rejectAllPending(new Error(reason));
		this.emitter.removeAllListeners();
	}

	private readonly handleStdoutData = (chunk: string | Buffer): void => {
		this.parser.push(chunk);
	};

	private readonly handleStdoutEnd = (): void => {
		this.parser.end();
	};

	private handleRecord(record: RpcEvent | RpcResponse): void {
		if (isRpcResponse(record)) {
			this.handleResponse(record);
			return;
		}

		this.emitter.emit("event", record);
	}

	private handleResponse(response: RpcResponse): void {
		if (!response.id) return;
		const deferred = this.pending.get(response.id);
		if (!deferred) return;
		this.pending.delete(response.id);

		if (response.success) {
			deferred.resolve(response.data);
			return;
		}

		deferred.reject(new Error(response.error ?? `RPC command failed: ${response.command}`));
	}

	private handleParseError(error: Error, line: string): void {
		this.emitter.emit("error", new Error(`Failed to parse RPC line: ${error.message}\nLine: ${line}`));
	}

	private nextId(): string {
		this.requestCounter += 1;
		return `rpc-${this.requestCounter}`;
	}

	private rejectAllPending(error: Error): void {
		for (const deferred of this.pending.values()) {
			deferred.reject(error);
		}
		this.pending.clear();
	}
}
