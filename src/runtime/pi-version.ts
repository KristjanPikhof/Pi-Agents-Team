import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof nodeSpawn;

export const HOST_PI_VERSION = VERSION;
export const MINIMUM_WORKER_PI_VERSION = "0.80.6";

export interface ParsedPiVersion {
	major: number;
	minor: number;
	patch: number;
	text: string;
}

export interface PiVersionCommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
	error?: Error;
}

export type RunPiVersionCommand = (input: {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
}) => Promise<PiVersionCommandResult>;

export interface PiVersionProbeOptions {
	command?: string;
	baseArgs?: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

export interface PiVersionProbeResult {
	command: string;
	versionArgs: string[];
	hostVersion: string;
	minimumVersion: string;
	workerVersion?: string;
	supported: boolean;
	mismatch: boolean;
	message?: string;
}

export type ProbeWorkerPiVersion = (options: PiVersionProbeOptions) => Promise<PiVersionProbeResult>;

const probeCache = new Map<string, Promise<PiVersionProbeResult>>();

export function parsePiVersion(output: string): ParsedPiVersion | undefined {
	const match = output.trim().match(/^(?:pi(?:\s+version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/i);
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
	};
}

export function comparePiVersions(left: ParsedPiVersion, right: ParsedPiVersion): number {
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function versionPrefix(baseArgs: string[] | undefined): string[] {
	if (!baseArgs) return [];
	const prefix: string[] = [];
	for (const arg of baseArgs) {
		if (arg.startsWith("-")) break;
		prefix.push(arg);
	}
	return prefix;
}

function commandCacheKey(command: string, args: string[]): string {
	const resolvedCommand = command.includes("/") || command.includes("\\") ? resolve(command) : command;
	return `${resolvedCommand}\0${args.join("\0")}`;
}

export const runPiVersionCommand: RunPiVersionCommand = ({ command, args, cwd, env }) => new Promise((resolveResult) => {
	const spawn = process.platform === "win32" ? crossSpawn : nodeSpawn;
	const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	const settle = (result: PiVersionCommandResult) => {
		if (settled) return;
		settled = true;
		resolveResult(result);
	};
	child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
	child.on("error", (error) => settle({ stdout, stderr, code: null, error }));
	child.on("close", (code) => settle({ stdout, stderr, code }));
});

export async function probeWorkerPiVersion(
	options: PiVersionProbeOptions,
	run: RunPiVersionCommand = runPiVersionCommand,
): Promise<PiVersionProbeResult> {
	const command = options.command ?? "pi";
	const versionArgs = [...versionPrefix(options.baseArgs), "--version"];
	const key = commandCacheKey(command, versionArgs);
	const existing = probeCache.get(key);
	if (existing) return existing;

	const pending = (async (): Promise<PiVersionProbeResult> => {
		const common = {
			command,
			versionArgs,
			hostVersion: HOST_PI_VERSION,
			minimumVersion: MINIMUM_WORKER_PI_VERSION,
		};
		let result: PiVersionCommandResult;
		try {
			result = await run({ command, args: versionArgs, cwd: options.cwd, env: options.env });
		} catch (error) {
			result = { stdout: "", stderr: "", code: null, error: error instanceof Error ? error : new Error(String(error)) };
		}
		if (result.error || result.code !== 0) {
			const detail = result.error?.message ?? result.stderr.trim() || `exit code ${result.code}`;
			return {
				...common,
				supported: false,
				mismatch: false,
				message: `Cannot launch Pi worker: failed to run ${basename(command)} --version (${detail}). Install Pi ${MINIMUM_WORKER_PI_VERSION} or newer, or fix rpc.command.`,
			};
		}
		const parsed = parsePiVersion(result.stdout);
		if (!parsed) {
			const shown = result.stdout.trim() || "no version output";
			return {
				...common,
				supported: false,
				mismatch: false,
				message: `Cannot launch Pi worker: ${basename(command)} --version returned an unparseable version (${JSON.stringify(shown)}). Install Pi ${MINIMUM_WORKER_PI_VERSION} or newer, or fix rpc.command.`,
			};
		}
		const minimum = parsePiVersion(MINIMUM_WORKER_PI_VERSION)!;
		const supported = comparePiVersions(parsed, minimum) >= 0;
		return {
			...common,
			workerVersion: parsed.text,
			supported,
			mismatch: supported && parsed.text !== HOST_PI_VERSION,
			...(supported ? {} : {
				message: `Cannot launch Pi worker: ${basename(command)} is Pi ${parsed.text}, but RPC workers require Pi ${MINIMUM_WORKER_PI_VERSION} or newer. Update the selected worker command or rpc.command.`,
			}),
		};
	})();
	probeCache.set(key, pending);
	return pending;
}

export function clearPiVersionProbeCache(): void {
	probeCache.clear();
}
