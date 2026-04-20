import { EventEmitter } from "node:events";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { TaskRegistry } from "./task-registry";
import { resolveWorkerMessageDelivery } from "../comms/agent-messaging";
import { buildPassivePing } from "../comms/ping";
import { buildWorkerTaskPrompt } from "../prompts/contracts";
import { resolveProfile } from "../profiles/loader";
import { WorkerManager } from "../runtime/worker-manager";
import { applyLaunchPolicy } from "../safety/launch-policy";
import type {
	DelegatedTaskInput,
	PersistedTeamState,
	TeamConfig,
	TeamPathScope,
	ThinkingLevel,
	WorkerExtensionMode,
	WorkerRuntimeState,
} from "../types";

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
		const taskId = createId("task");
		const workerId = createId("worker");
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

	async messageWorker(workerId: string, message: string, delivery: "auto" | "steer" | "follow_up" = "auto"): Promise<AgentResult> {
		const worker = this.requireWorker(workerId);
		const nextDelivery = resolveWorkerMessageDelivery(worker.status, delivery);

		if (nextDelivery === "steer") {
			await this.workerManager.steerWorker(workerId, message);
		} else {
			await this.workerManager.followUpWorker(workerId, message);
		}

		await this.workerManager.refreshState(workerId);
		return this.requireResult(workerId);
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
