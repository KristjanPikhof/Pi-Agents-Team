import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import { createDeferred } from "./deferred.js";
import type { ThinkingLevel, WorkerExtensionMode, WorkerProjectTrustOverride } from "../types.js";

const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof nodeSpawn;

export type WorkerSpawnImplementation = "node:child_process" | "cross-spawn";

export function resolveWorkerSpawnImplementation(platform: NodeJS.Platform = process.platform): WorkerSpawnImplementation {
	return platform === "win32" ? "cross-spawn" : "node:child_process";
}

function selectSpawn(platform: NodeJS.Platform = process.platform): typeof nodeSpawn {
	return resolveWorkerSpawnImplementation(platform) === "cross-spawn" ? crossSpawn : nodeSpawn;
}

export interface WorkerProcessOptions {
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
	/**
	 * When true, do NOT pass `--no-skills` to the worker Pi session. Needed when
	 * the delegated task requested `skills: [...]`: without this, Pi's skill
	 * discovery is disabled and the requested skill names have no available
	 * skill context in the worker session. Default `false` keeps the tighter
	 * worker-minimal footprint.
	 */
	allowSkills?: boolean;
	extraArgs?: string[];
	env?: NodeJS.ProcessEnv;
}

export interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export interface WorkerTransport {
	pid?: number;
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: string, listener: (...args: unknown[]) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
}

export interface WorkerProcessHandle {
	readonly transport: WorkerTransport;
	readonly pid?: number;
	readonly stderrBuffer: string;
	waitForExit(): Promise<ExitInfo>;
	kill(signal?: NodeJS.Signals): boolean;
	dispose(signal?: NodeJS.Signals): Promise<ExitInfo>;
}

export type SpawnWorkerProcess = (options: WorkerProcessOptions) => WorkerProcessHandle;

const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_EXIT_WAIT_MS = 500;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 500;
export const WORKER_PROCESS_DISPOSE_MAX_MS = WINDOWS_TREE_KILL_TIMEOUT_MS + PROCESS_EXIT_WAIT_MS;

interface KillableProcess {
	pid?: number;
	kill(signal?: NodeJS.Signals): boolean;
}

interface TaskkillProcess extends KillableProcess {
	once(event: "error", listener: () => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
}

type TaskkillSpawn = (command: string, args: string[], options: { stdio: "ignore" }) => TaskkillProcess;

function delay(ms: number): Promise<void> {
	const { promise, resolve } = createDeferred<void>();
	setTimeout(resolve, ms);
	return promise;
}

function tryKill(processHandle: KillableProcess, signal: NodeJS.Signals): void {
	try {
		processHandle.kill(signal);
	} catch {
		// The process may already have exited.
	}
}

export async function terminateWindowsWorkerTree(
	processHandle: KillableProcess,
	spawnTaskkill: TaskkillSpawn = crossSpawn as unknown as TaskkillSpawn,
	timeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
): Promise<void> {
	if (processHandle.pid === undefined) {
		tryKill(processHandle, "SIGKILL");
		return;
	}
	const { promise, resolve } = createDeferred<void>();
	let killer: TaskkillProcess | undefined;
	let settled = false;
	const finish = (fallback: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		if (fallback) tryKill(processHandle, "SIGKILL");
		resolve();
	};
	const timeout = setTimeout(() => {
		if (killer) tryKill(killer, "SIGKILL");
		finish(true);
	}, timeoutMs);
	try {
		killer = spawnTaskkill("taskkill", ["/pid", String(processHandle.pid), "/T", "/F"], { stdio: "ignore" });
		killer.once("error", () => finish(true));
		killer.once("close", (code) => finish(code !== 0));
	} catch {
		finish(true);
	}
	await promise;
}

function signalPosixProcessGroup(processHandle: KillableProcess, signal: NodeJS.Signals): boolean {
	if (processHandle.pid === undefined) return processHandle.kill(signal);
	try {
		process.kill(-processHandle.pid, signal);
		return true;
	} catch {
		return processHandle.kill(signal);
	}
}

async function waitForExitBounded(exitPromise: Promise<ExitInfo>, timeoutMs: number): Promise<ExitInfo | undefined> {
	return Promise.race([
		exitPromise,
		delay(timeoutMs).then(() => undefined),
	]);
}

class NodeWorkerProcessHandle extends EventEmitter implements WorkerProcessHandle {
	private stderr = "";
	private readonly exitPromise: Promise<ExitInfo>;
	private disposePromise?: Promise<ExitInfo>;

	constructor(
		readonly transport: WorkerTransport,
		private readonly platform: NodeJS.Platform = process.platform,
	) {
		super();
		this.transport.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.transport.stdin.on("error", () => {
			// Child process launch failures are reported through the process "error" event below.
		});
		const { promise, resolve } = createDeferred<ExitInfo>();
		this.exitPromise = promise;
		this.transport.on("exit", (code, signal) => resolve({ code, signal }));
		this.transport.on("error", (error) => {
			this.stderr += `${error.message}\n`;
			resolve({ code: null, signal: null, error });
		});
	}

	get pid(): number | undefined {
		return this.transport.pid;
	}

	get stderrBuffer(): string {
		return this.stderr;
	}

	waitForExit(): Promise<ExitInfo> {
		return this.exitPromise;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		return this.platform === "win32"
			? this.transport.kill(signal)
			: signalPosixProcessGroup(this.transport, signal);
	}

	dispose(signal: NodeJS.Signals = "SIGTERM"): Promise<ExitInfo> {
		if (!this.disposePromise) this.disposePromise = this.disposeProcess(signal);
		return this.disposePromise;
	}

	private async disposeProcess(signal: NodeJS.Signals): Promise<ExitInfo> {
		if (this.platform === "win32") {
			await terminateWindowsWorkerTree(this.transport);
		} else {
			this.kill(signal);
			await delay(PROCESS_TERMINATION_GRACE_MS);
			this.kill("SIGKILL");
		}
		return (await waitForExitBounded(this.exitPromise, PROCESS_EXIT_WAIT_MS))
			?? { code: null, signal: "SIGKILL" };
	}
}

export function buildWorkerProcessArgs(options: WorkerProcessOptions): string[] {
	const args = [...(options.baseArgs ?? ["--mode", "rpc", "--no-session"])];

	if (options.projectTrust === "approve") args.push("--approve");
	if (options.projectTrust === "no-approve") args.push("--no-approve");
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.systemPromptPath) args.push("--append-system-prompt", options.systemPromptPath);
	if (options.extensionMode && options.extensionMode !== "inherit") {
		args.push("--no-extensions");
		if (options.extensionMode === "worker-minimal") {
			for (const source of options.workerExtensions ?? []) args.push("--extension", source);
		}
		args.push("--no-prompt-templates", "--no-themes", "--no-context-files");
		if (!options.allowSkills) args.push("--no-skills");
	}
	if (options.extraArgs) args.push(...options.extraArgs);

	return args;
}

export function spawnWorkerProcess(options: WorkerProcessOptions): WorkerProcessHandle {
	const command = options.command ?? "pi";
	const args = buildWorkerProcessArgs(options);
	const spawn = selectSpawn();
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		...(process.platform === "win32" ? {} : { detached: true }),
	}) as ChildProcessWithoutNullStreams;

	return new NodeWorkerProcessHandle(child as unknown as WorkerTransport);
}
