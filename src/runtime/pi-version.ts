import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, extname, isAbsolute, resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as typeof nodeSpawn;

export const HOST_PI_VERSION = VERSION;
export const MINIMUM_WORKER_PI_VERSION = "0.80.6";
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DIAGNOSTIC_LIMIT_CHARS = 500;

export interface ParsedPiVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
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
	timeoutMs: number;
}) => Promise<PiVersionCommandResult>;

export interface PiVersionProbeOptions {
	command?: string;
	baseArgs?: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
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
	const match = output.trim().match(
		/^(?:pi(?:\s+version)?\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i,
	);
	if (!match) return undefined;
	const prerelease = match[4]?.split(".") ?? [];
	if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
		return undefined;
	}
	const core = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease,
		text: `${core}${prerelease.length > 0 ? `-${prerelease.join(".")}` : ""}`,
	};
}

export function comparePiVersions(left: ParsedPiVersion, right: ParsedPiVersion): number {
	const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
	if (core !== 0) return core;
	if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
	if (right.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);
		if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}

const NODE_OPTIONS_WITH_VALUE = new Set([
	"-r",
	"--require",
	"--loader",
	"--experimental-loader",
	"--import",
	"--conditions",
	"--inspect-port",
]);

function versionPrefix(command: string, baseArgs: string[] | undefined): string[] {
	if (!baseArgs) return [];
	const commandName = basename(command).toLowerCase().replace(/\.exe$/, "");
	if (commandName === "node" || commandName === "bun" || commandName === "deno") {
		const prefix: string[] = [];
		for (let index = 0; index < baseArgs.length; index += 1) {
			const arg = baseArgs[index];
			if (arg === "--") {
				prefix.push(arg);
				if (baseArgs[index + 1]) prefix.push(baseArgs[index + 1]);
				break;
			}
			prefix.push(arg);
			if (NODE_OPTIONS_WITH_VALUE.has(arg) && baseArgs[index + 1]) {
				prefix.push(baseArgs[index + 1]);
				index += 1;
				continue;
			}
			if (!arg.startsWith("-")) break;
		}
		return prefix;
	}
	const firstPiOption = baseArgs.findIndex((arg) => arg.startsWith("-"));
	return firstPiOption === -1 ? [...baseArgs] : baseArgs.slice(0, firstPiOption);
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32" || extname(command)) return [command];
	const pathExt = env.PATHEXT ?? env.PathExt ?? ".COM;.EXE;.BAT;.CMD";
	return [command, ...pathExt.split(";").filter(Boolean).map((extension) => `${command}${extension.toLowerCase()}`)];
}

function resolveCommandIdentity(command: string, cwd: string, suppliedEnv?: NodeJS.ProcessEnv): string {
	const env = suppliedEnv ?? process.env;
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return resolve(cwd, command);
	}
	const pathValue = env.PATH ?? env.Path ?? env.Pathname ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const candidate of executableCandidates(command, env)) {
			const path = resolve(cwd, directory, candidate);
			if (existsSync(path)) return path;
		}
	}
	return `unresolved:${command}\0cwd:${resolve(cwd)}\0path:${pathValue}`;
}

function commandCacheKey(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	return `${resolveCommandIdentity(command, cwd, env)}\0${args.join("\0")}`;
}

function appendCapped(current: string, chunk: unknown): string {
	if (Buffer.byteLength(current, "utf8") >= PROBE_OUTPUT_LIMIT_BYTES) return current;
	const remaining = PROBE_OUTPUT_LIMIT_BYTES - Buffer.byteLength(current, "utf8");
	return current + Buffer.from(String(chunk)).subarray(0, remaining).toString();
}

function diagnostic(value: string): string {
	const trimmed = value.trim();
	return trimmed.length <= DIAGNOSTIC_LIMIT_CHARS ? trimmed : `${trimmed.slice(0, DIAGNOSTIC_LIMIT_CHARS)}… [truncated]`;
}

export const runPiVersionCommand: RunPiVersionCommand = ({ command, args, cwd, env, timeoutMs }) => new Promise((resolveResult) => {
	const spawn = process.platform === "win32" ? crossSpawn : nodeSpawn;
	const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	let forceKillTimer: NodeJS.Timeout | undefined;
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
		forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
		forceKillTimer.unref?.();
		settle({ stdout, stderr, code: null, error: new Error(`version probe timed out after ${timeoutMs}ms`) });
	}, timeoutMs);
	timeout.unref?.();
	const settle = (result: PiVersionCommandResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		resolveResult(result);
	};
	child.stdout?.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
	child.stderr?.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
	child.on("error", (error) => settle({ stdout, stderr, code: null, error }));
	child.on("close", (code) => {
		if (forceKillTimer) clearTimeout(forceKillTimer);
		settle({ stdout, stderr, code });
	});
});

export async function probeWorkerPiVersion(
	options: PiVersionProbeOptions,
	run: RunPiVersionCommand = runPiVersionCommand,
): Promise<PiVersionProbeResult> {
	const command = options.command ?? "pi";
	const versionArgs = [...versionPrefix(command, options.baseArgs), "--version"];
	const key = commandCacheKey(command, versionArgs, options.cwd, options.env);
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
			result = await run({
				command,
				args: versionArgs,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
			});
		} catch (error) {
			result = { stdout: "", stderr: "", code: null, error: error instanceof Error ? error : new Error(String(error)) };
		}
		if (result.error || result.code !== 0) {
			const detail = diagnostic(result.error?.message ?? (result.stderr.trim() || `exit code ${result.code}`));
			return {
				...common,
				supported: false,
				mismatch: false,
				message: `Cannot launch Pi worker: failed to run ${basename(command)} --version (${detail}). Install Pi ${MINIMUM_WORKER_PI_VERSION} or newer, or fix rpc.command.`,
			};
		}
		const parsed = parsePiVersion(result.stdout);
		if (!parsed) {
			const shown = diagnostic(result.stdout) || "no version output";
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
	const result = await pending;
	if (!result.supported && probeCache.get(key) === pending) probeCache.delete(key);
	return result;
}

export function clearPiVersionProbeCache(): void {
	probeCache.clear();
}
