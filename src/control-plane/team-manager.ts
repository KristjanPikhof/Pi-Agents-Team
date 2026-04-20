import { EventEmitter } from "node:events";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { TaskRegistry } from "./task-registry";
import { WorkerManager } from "../runtime/worker-manager";
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

function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDelegationPrompt(task: DelegatedTaskInput): string {
	return [
		"You are a subordinate Pi Agent Team worker.",
		"Report only to the orchestrator. Do not address the end user directly.",
		`Task title: ${task.title}`,
		`Goal: ${task.goal}`,
		task.expectedOutput ? `Expected output: ${task.expectedOutput}` : undefined,
		task.contextHints.length > 0 ? `Context hints:\n- ${task.contextHints.join("\n- ")}` : undefined,
		task.pathScope ? `Path scope: ${task.pathScope.roots.join(", ")}` : undefined,
		"Return a compact summary that includes findings, touched files, risks, and a next recommendation.",
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}

export class TeamManager {
	private readonly events = new EventEmitter();
	private readonly registry: TaskRegistry;
	private readonly workerManager: WorkerManager;

	constructor(options?: { config?: TeamConfig; registry?: TaskRegistry; workerManager?: WorkerManager }) {
		this.config = options?.config ?? DEFAULT_TEAM_CONFIG;
		this.registry = options?.registry ?? new TaskRegistry();
		this.workerManager = options?.workerManager ?? new WorkerManager();
		this.workerManager.onEvent((worker) => {
			this.registry.upsertWorker(worker.state);
			this.events.emit("state_change", this.snapshot());
		});
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
		const profile = this.config.profiles.find((item: TeamConfig["profiles"][number]) => item.name === request.profileName);
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
			pathScope: request.pathScope,
			createdAt: Date.now(),
		};

		this.registry.registerTask(task);

		const worker = await this.workerManager.launchWorker({
			workerId,
			profileName: request.profileName,
			task,
			cwd: request.cwd,
			model: request.model ?? profile?.model,
			thinkingLevel: request.thinkingLevel ?? profile?.thinkingLevel,
			tools: request.tools ?? profile?.tools,
			systemPromptPath: request.systemPromptPath,
			extensionMode: request.extensionMode ?? profile?.extensionMode ?? this.config.safety.defaultWorkerExtensionMode,
		});

		this.registry.upsertWorker(worker.state);
		await this.workerManager.promptWorker(workerId, buildDelegationPrompt(task));
		this.events.emit("state_change", this.snapshot());
		return { worker: worker.state, task };
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

	async messageWorker(workerId: string, message: string, delivery: "auto" | "steer" | "follow_up" = "auto"): Promise<AgentResult> {
		const worker = this.requireWorker(workerId);
		const nextDelivery = delivery === "auto" ? (worker.status === "running" ? "steer" : "follow_up") : delivery;

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

		return workerIds.map((workerId) => this.requireResult(workerId));
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
