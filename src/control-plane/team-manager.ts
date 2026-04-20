import { EventEmitter } from "node:events";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { TaskRegistry } from "./task-registry";
import { resolveWorkerMessageDelivery } from "../comms/agent-messaging";
import { buildPassivePing } from "../comms/ping";
import { buildWorkerTaskPrompt } from "../prompts/contracts";
import { resolveProfile } from "../profiles/loader";
import { WorkerManager, type WorkerConsoleEvent } from "../runtime/worker-manager";
import { applyLaunchPolicy } from "../safety/launch-policy";
import type {
	DelegatedTaskInput,
	PersistedTeamState,
	TeamConfig,
	TeamPathScope,
	ThinkingLevel,
	WorkerExtensionMode,
	WorkerRuntimeState,
	WorkerStatus,
} from "../types";

const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
	"idle",
	"completed",
	"aborted",
	"error",
	"exited",
]);

export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export interface DelegateTaskRequest {
	title: string;
	goal: string;
	profileName: string;
	cwd: string;
	contextHints?: string[];
	expectedOutput?: string;
	pathScope?: TeamPathScope;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	systemPromptPath?: string;
	extensionMode?: WorkerExtensionMode;
}

export interface AgentResult {
	worker: WorkerRuntimeState;
	task?: DelegatedTaskInput;
}

export interface AgentMessageResult extends AgentResult {
	delivery: "steer" | "follow_up";
}

export interface PingAgentsRequest {
	workerIds?: string[];
	mode?: "passive" | "active";
}

export class TeamManager {
	private readonly events = new EventEmitter();
	private readonly registry: TaskRegistry;
	private readonly workerManager: WorkerManager;
	private workerCounter = 0;
	private taskCounter = 0;

	constructor(options?: { config?: TeamConfig; registry?: TaskRegistry; workerManager?: WorkerManager }) {
		this.config = options?.config ?? DEFAULT_TEAM_CONFIG;
		this.registry = options?.registry ?? new TaskRegistry();
		this.workerManager = options?.workerManager ?? new WorkerManager();
		this.workerManager.onEvent((worker) => {
			this.registry.upsertWorker(worker.state);
			this.events.emit("state_change", this.snapshot());
		});
	}

	private nextWorkerId(): string {
		do {
			this.workerCounter += 1;
			const candidate = `w${this.workerCounter}`;
			if (!this.registry.getWorker(candidate)) return candidate;
		} while (this.workerCounter < 10000);
		throw new Error("Could not allocate worker id");
	}

	private nextTaskId(): string {
		this.taskCounter += 1;
		return `t${this.taskCounter}`;
	}

	resolveWorkerId(input: string): string | undefined {
		const trimmed = input.trim();
		if (!trimmed) return undefined;
		const direct = this.registry.getWorker(trimmed);
		if (direct) return direct.workerId;

		const numeric = /^\d+$/.test(trimmed) ? `w${trimmed}` : undefined;
		if (numeric) {
			const byNumeric = this.registry.getWorker(numeric);
			if (byNumeric) return byNumeric.workerId;
		}

		const lowered = trimmed.toLowerCase();
		const matches = this.registry.listWorkers().filter((worker) => worker.workerId.toLowerCase().startsWith(lowered));
		if (matches.length === 1) return matches[0].workerId;
		return undefined;
	}

	readonly config: TeamConfig;

	onStateChange(listener: (state: PersistedTeamState) => void): () => void {
		this.events.on("state_change", listener);
		return () => this.events.off("state_change", listener);
	}

	restore(state: PersistedTeamState): void {
		this.registry.restore(state);
		for (const worker of this.registry.listWorkers()) {
			const match = /^w(\d+)$/.exec(worker.workerId);
			if (match) this.workerCounter = Math.max(this.workerCounter, Number(match[1]));
		}
		for (const taskId of Object.keys(state.taskRegistry ?? {})) {
			const match = /^t(\d+)$/.exec(taskId);
			if (match) this.taskCounter = Math.max(this.taskCounter, Number(match[1]));
		}
		this.events.emit("state_change", this.snapshot());
	}

	snapshot(): PersistedTeamState {
		return this.registry.snapshot();
	}

	async delegateTask(request: DelegateTaskRequest): Promise<AgentResult> {
		const profile = resolveProfile(request.profileName);
		const launchPlan = applyLaunchPolicy(
			{
				cwd: request.cwd,
				profile,
				pathScope: request.pathScope,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				tools: request.tools,
				extensionMode: request.extensionMode,
				systemPromptPath: request.systemPromptPath,
			},
			this.config,
		);
		const taskId = this.nextTaskId();
		const workerId = this.nextWorkerId();
		const task: DelegatedTaskInput = {
			taskId,
			title: request.title,
			goal: request.goal,
			requestedBy: "orchestrator",
			profileName: request.profileName,
			cwd: request.cwd,
			contextHints: request.contextHints ?? [],
			expectedOutput: request.expectedOutput,
			pathScope: launchPlan.pathScope,
			createdAt: Date.now(),
		};

		this.registry.registerTask(task);

		const worker = await this.workerManager.launchWorker({
			workerId,
			profileName: request.profileName,
			task,
			cwd: launchPlan.cwd,
			model: launchPlan.model,
			thinkingLevel: launchPlan.thinkingLevel,
			tools: launchPlan.tools,
			systemPromptPath: launchPlan.systemPromptPath,
			extensionMode: launchPlan.extensionMode,
		});

		this.registry.upsertWorker(worker.state);
		await this.workerManager.promptWorker(workerId, buildWorkerTaskPrompt(task));
		const liveWorker = this.workerManager.getWorker(workerId);
		if (liveWorker) {
			this.registry.upsertWorker(liveWorker.state);
		}
		this.events.emit("state_change", this.snapshot());
		return { worker: liveWorker?.state ?? worker.state, task };
	}

	listWorkers(): WorkerRuntimeState[] {
		return this.registry.listWorkers();
	}

	getWorkerStatus(workerId: string): WorkerRuntimeState | undefined {
		return this.registry.getWorker(workerId);
	}

	getWorkerResult(workerId: string): AgentResult | undefined {
		const worker = this.registry.getWorker(workerId);
		if (!worker) return undefined;
		return {
			worker,
			task: worker.currentTask ? this.registry.getTask(worker.currentTask.taskId) : undefined,
		};
	}

	getWorkerTranscript(workerId: string): string | undefined {
		return this.workerManager.getWorkerTranscript(workerId);
	}

	getWorkerConsole(workerId: string): WorkerConsoleEvent[] | undefined {
		return this.workerManager.getWorkerConsole(workerId);
	}

	async messageWorker(workerId: string, message: string, delivery: "auto" | "steer" | "follow_up" = "auto"): Promise<AgentMessageResult> {
		const worker = this.requireWorker(workerId);
		const nextDelivery = resolveWorkerMessageDelivery(worker.status, delivery);

		if (nextDelivery === "steer") {
			await this.workerManager.steerWorker(workerId, message);
		} else {
			await this.workerManager.followUpWorker(workerId, message);
		}

		await this.workerManager.refreshState(workerId);
		const result = this.requireResult(workerId);
		return { ...result, delivery: nextDelivery };
	}

	async messageAllWorkers(message: string, delivery: "auto" | "steer" | "follow_up" = "auto"): Promise<AgentMessageResult[]> {
		const deliverable: WorkerStatus[] = ["running", "idle", "waiting_followup"];
		const targets = this.listWorkers().filter((worker) => deliverable.includes(worker.status));
		const results: AgentMessageResult[] = [];
		for (const worker of targets) {
			try {
				results.push(await this.messageWorker(worker.workerId, message, delivery));
			} catch (error) {
				const latest = this.registry.getWorker(worker.workerId);
				if (!latest) continue;
				results.push({
					worker: { ...latest, error: error instanceof Error ? error.message : String(error) },
					task: latest.currentTask ? this.registry.getTask(latest.currentTask.taskId) : undefined,
					delivery: delivery === "follow_up" ? "follow_up" : "steer",
				});
			}
		}
		return results;
	}

	async cancelAllWorkers(): Promise<AgentResult[]> {
		const targets = this.listWorkers().filter((worker) => !isTerminalWorkerStatus(worker.status));
		const results: AgentResult[] = [];
		for (const worker of targets) {
			try {
				results.push(await this.cancelWorker(worker.workerId));
			} catch (error) {
				const latest = this.registry.getWorker(worker.workerId);
				if (!latest) continue;
				results.push({
					worker: { ...latest, error: error instanceof Error ? error.message : String(error) },
					task: latest.currentTask ? this.registry.getTask(latest.currentTask.taskId) : undefined,
				});
			}
		}
		return results;
	}

	async pingWorkers(request: PingAgentsRequest = {}): Promise<AgentResult[]> {
		const mode = request.mode ?? "passive";
		const workerIds = request.workerIds?.length ? request.workerIds : this.listWorkers().map((worker) => worker.workerId);

		if (mode === "active") {
			await Promise.all(
				workerIds.map(async (workerId) => {
					await this.workerManager.refreshState(workerId);
					await this.workerManager.refreshStats(workerId);
				}),
			);
		}

		return workerIds.map((workerId) => {
			const result = this.requireResult(workerId);
			result.worker.lastSummary = result.worker.lastSummary ?? {
				workerId: result.worker.workerId,
				taskId: result.worker.currentTask?.taskId ?? result.worker.workerId,
				headline: buildPassivePing(result.worker).lastSummary ?? `${result.worker.profileName}:${result.worker.status}`,
				status: result.worker.status,
				currentToolName: result.worker.lastToolName,
				readFiles: [],
				changedFiles: [],
				risks: [],
				relayQuestionCount: result.worker.pendingRelayQuestions.length,
				updatedAt: Date.now(),
			};
			return result;
		});
	}

	async cancelWorker(workerId: string): Promise<AgentResult> {
		await this.workerManager.abortWorker(workerId);
		await this.workerManager.shutdownWorker(workerId);
		const worker = this.registry.markWorkerExited(workerId, "Worker cancelled by orchestrator.");
		if (!worker) {
			throw new Error(`Unknown worker: ${workerId}`);
		}
		this.events.emit("state_change", this.snapshot());
		return this.requireResult(workerId);
	}

	async dispose(): Promise<void> {
		await this.workerManager.dispose();
	}

	pruneTerminalWorkers(): WorkerRuntimeState[] {
		const terminal = this.registry.listWorkers().filter((worker) => isTerminalWorkerStatus(worker.status));
		const removed: WorkerRuntimeState[] = [];
		for (const worker of terminal) {
			const result = this.registry.removeWorker(worker.workerId);
			if (result) removed.push(result);
		}
		if (removed.length > 0) {
			this.events.emit("state_change", this.snapshot());
		}
		return removed;
	}

	aggregateUsage(): { workers: number; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number } {
		const workers = this.registry.listWorkers();
		return workers.reduce(
			(acc, worker) => ({
				workers: acc.workers + 1,
				turns: acc.turns + worker.usage.turns,
				inputTokens: acc.inputTokens + worker.usage.inputTokens,
				outputTokens: acc.outputTokens + worker.usage.outputTokens,
				cacheReadTokens: acc.cacheReadTokens + worker.usage.cacheReadTokens,
				cacheWriteTokens: acc.cacheWriteTokens + worker.usage.cacheWriteTokens,
				costUsd: acc.costUsd + worker.usage.costUsd,
			}),
			{ workers: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		);
	}

	async waitForTerminal(
		targetIds: string[],
		options: { timeoutMs?: number; signal?: AbortSignal; wakeOnRelay?: boolean } = {},
	): Promise<{
		reason: "all_terminal" | "timeout" | "aborted" | "relay_raised";
		workers: WorkerRuntimeState[];
		newRelays?: Array<{ workerId: string; profileName: string; question: string; urgency: string }>;
	}> {
		const resolved = targetIds
			.map((id) => this.resolveWorkerId(id) ?? id)
			.filter((id, index, arr) => arr.indexOf(id) === index);
		const wakeOnRelay = options.wakeOnRelay !== false;

		const baselineRelays = new Map<string, number>();
		for (const id of resolved) {
			const worker = this.registry.getWorker(id);
			baselineRelays.set(id, worker?.pendingRelayQuestions.length ?? 0);
		}

		const snapshotTargets = (): WorkerRuntimeState[] =>
			resolved
				.map((id) => this.registry.getWorker(id))
				.filter((worker): worker is WorkerRuntimeState => Boolean(worker));

		const allTerminal = (): boolean => {
			const workers = snapshotTargets();
			if (workers.length < resolved.length) return false;
			return workers.every((worker) => isTerminalWorkerStatus(worker.status));
		};

		const collectNewRelays = (): Array<{ workerId: string; profileName: string; question: string; urgency: string }> => {
			const newRelays: Array<{ workerId: string; profileName: string; question: string; urgency: string }> = [];
			for (const worker of snapshotTargets()) {
				const baseline = baselineRelays.get(worker.workerId) ?? 0;
				if (worker.pendingRelayQuestions.length > baseline) {
					for (const relay of worker.pendingRelayQuestions.slice(baseline)) {
						newRelays.push({
							workerId: worker.workerId,
							profileName: worker.profileName,
							question: relay.question,
							urgency: relay.urgency,
						});
					}
				}
			}
			return newRelays;
		};

		if (allTerminal()) {
			return { reason: "all_terminal", workers: snapshotTargets() };
		}

		return new Promise((resolve) => {
			let settled = false;
			const timeoutMs = options.timeoutMs ?? 300_000;

			const cleanup = () => {
				this.events.off("state_change", listener);
				if (timer) clearTimeout(timer);
				if (options.signal) options.signal.removeEventListener("abort", onAbort);
			};

			const finish = (reason: "all_terminal" | "timeout" | "aborted" | "relay_raised") => {
				if (settled) return;
				settled = true;
				cleanup();
				const payload: {
					reason: typeof reason;
					workers: WorkerRuntimeState[];
					newRelays?: Array<{ workerId: string; profileName: string; question: string; urgency: string }>;
				} = { reason, workers: snapshotTargets() };
				if (reason === "relay_raised") payload.newRelays = collectNewRelays();
				resolve(payload);
			};

			const listener = () => {
				if (allTerminal()) {
					finish("all_terminal");
					return;
				}
				if (wakeOnRelay && collectNewRelays().length > 0) {
					finish("relay_raised");
				}
			};
			const onAbort = () => finish("aborted");
			const timer = setTimeout(() => finish("timeout"), timeoutMs);

			this.events.on("state_change", listener);
			if (options.signal) {
				if (options.signal.aborted) {
					finish("aborted");
					return;
				}
				options.signal.addEventListener("abort", onAbort);
			}
		});
	}

	private requireWorker(workerId: string): WorkerRuntimeState {
		const worker = this.registry.getWorker(workerId);
		if (!worker) {
			throw new Error(`Unknown worker: ${workerId}`);
		}
		return worker;
	}

	private requireResult(workerId: string): AgentResult {
		const result = this.getWorkerResult(workerId);
		if (!result) {
			throw new Error(`Unknown worker: ${workerId}`);
		}
		return result;
	}
}
