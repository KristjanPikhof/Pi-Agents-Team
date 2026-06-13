import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import type { ThinkingLevel, WorkerExtensionMode, WorkerProjectTrustOverride } from "../types";

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
}

export interface WorkerTransport {
	pid?: number;
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: string, listener: (...args: unknown[]) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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

class NodeWorkerProcessHandle extends EventEmitter implements WorkerProcessHandle {
	private stderr = "";
	private exitPromise: Promise<ExitInfo>;

	constructor(readonly transport: WorkerTransport) {
		super();
		this.transport.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.exitPromise = new Promise<ExitInfo>((resolve) => {
			this.transport.on("exit", (code, signal) => resolve({ code, signal }));
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
		return this.transport.kill(signal);
	}

	async dispose(signal: NodeJS.Signals = "SIGTERM"): Promise<ExitInfo> {
		this.kill(signal);
		return this.waitForExit();
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
		args.push("--no-extensions", "--no-prompt-templates", "--no-themes", "--no-context-files");
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
	}) as ChildProcessWithoutNullStreams;

	return new NodeWorkerProcessHandle(child as unknown as WorkerTransport);
}
