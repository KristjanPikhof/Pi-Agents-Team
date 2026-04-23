import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WorkerProcessHandle, WorkerTransport } from "../../src/runtime/worker-process";

interface MockCommand {
	type: string;
	id?: string;
	message?: string;
}

export interface MockTransportOptions {
	initialState?: Record<string, unknown>;
	onCommand?: (command: MockCommand) => void;
	promptText?: string | ((command: MockCommand) => string);
	rejectPrompt?: string;
	autoCompletePrompt?: boolean;
}

export class MockWorkerTransport extends EventEmitter implements WorkerTransport {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 4242;
	private buffer = "";
	private state: Record<string, unknown>;
	readonly commands: MockCommand[] = [];
	private pendingPromptText: string | null = null;

	constructor(private readonly options: MockTransportOptions = {}) {
		super();
		this.state = {
			model: null,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionId: "mock-session",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
			...(options.initialState ?? {}),
		};

		this.stdin.on("data", (chunk) => {
			this.buffer += chunk.toString();
			this.flush();
		});
	}

	kill(signal?: NodeJS.Signals): boolean {
		queueMicrotask(() => {
			this.emit("exit", signal === "SIGTERM" ? 0 : 1, signal ?? null);
			this.stdout.end();
			this.stderr.end();
		});
		return true;
	}

	writeEvent(event: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	setState(patch: Record<string, unknown>): void {
		this.state = { ...this.state, ...patch };
	}

	completePrompt(promptText = this.pendingPromptText ?? "Completed task"): void {
		this.writeEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: promptText }],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { total: 0.01 },
				},
			},
		});
		this.state.isStreaming = false;
		this.writeEvent({ type: "agent_end", messages: [] });
		this.pendingPromptText = null;
	}

	private flush(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line.trim()) continue;
			const command = JSON.parse(line) as MockCommand;
			this.commands.push(command);
			this.options.onCommand?.(command);
			this.handleCommand(command);
		}
	}

	private handleCommand(command: MockCommand): void {
		switch (command.type) {
			case "get_state":
				this.respond(command, this.state);
				break;
			case "get_session_stats":
				this.respond(command, {
					sessionId: this.state.sessionId,
					totalMessages: 1,
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					cost: 0.01,
					contextUsage: { tokens: 15, contextWindow: 200000, percent: 0.01 },
				});
				break;
			case "prompt":
				if (this.options.rejectPrompt) {
					this.respond(command, undefined, this.options.rejectPrompt);
					break;
				}
				this.respond(command, undefined);
				this.state.isStreaming = true;
				queueMicrotask(() => {
					const promptText =
						typeof this.options.promptText === "function"
							? this.options.promptText(command)
							: this.options.promptText ?? `Completed ${command.message ?? "task"}`;
					this.pendingPromptText = promptText;
					this.writeEvent({ type: "agent_start" });
					this.writeEvent({
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: `Working on: ${command.message ?? ""}` },
					});
					if (this.options.autoCompletePrompt !== false) {
						this.completePrompt(promptText);
					}
				});
				break;
			case "steer":
			case "follow_up":
			case "abort":
				this.respond(command, undefined);
				break;
			default:
				this.respond(command, undefined);
		}
	}

	private respond(command: MockCommand, data: unknown, error?: string): void {
		this.stdout.write(
			`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: error === undefined, data, error })}\n`,
		);
	}
}

export class MockWorkerHandle implements WorkerProcessHandle {
	private stderr = "";
	private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

	constructor(readonly transport: MockWorkerTransport) {
		this.transport.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.exitPromise = new Promise((resolve) => {
			this.transport.on("exit", (code, signal) => resolve({ code, signal }));
		});
	}

	get pid(): number | undefined {
		return this.transport.pid;
	}

	get stderrBuffer(): string {
		return this.stderr;
	}

	waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		return this.exitPromise;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		return this.transport.kill(signal);
	}

	dispose(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		this.transport.kill(signal);
		return this.exitPromise;
	}
}

export function waitForMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
