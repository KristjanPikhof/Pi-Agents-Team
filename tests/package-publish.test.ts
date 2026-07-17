import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const PACK_TIMEOUT_MS = 45_000;
const OFFLINE_INSTALL_TIMEOUT_MS = 45_000;
const CONSUMER_IMPORT_TIMEOUT_MS = 15_000;
const PI_PACKAGE_RESPONSE_TIMEOUT_MS = 25_000;
const PI_CHILD_STDIN_GRACE_MS = 1_000;
const PI_CHILD_TERM_GRACE_MS = 2_000;
const PI_CHILD_KILL_GRACE_MS = 2_000;
const PI_PACKAGE_LOAD_TIMEOUT_MS =
	PI_PACKAGE_RESPONSE_TIMEOUT_MS + PI_CHILD_STDIN_GRACE_MS + PI_CHILD_TERM_GRACE_MS + PI_CHILD_KILL_GRACE_MS;
const SETUP_CLEANUP_MARGIN_MS = 30_000;
const PACKAGE_TEST_TIMEOUT_MS = 180_000;
const BUDGETED_TEST_DURATION_MS =
	PACK_TIMEOUT_MS +
	OFFLINE_INSTALL_TIMEOUT_MS +
	CONSUMER_IMPORT_TIMEOUT_MS +
	PI_PACKAGE_LOAD_TIMEOUT_MS +
	SETUP_CLEANUP_MARGIN_MS;
const EXPECTED_EXTENSION_COMMANDS = [
	"team",
	"team-copy",
	"team-enable",
	"team-init",
	"team-result",
	"team-steer",
	"team-stop",
];

function subprocessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"),
	);
	return { ...env, npm_config_dry_run: "false", ...overrides };
}

function isolatedPiEnv(isolationRoot: string): NodeJS.ProcessEnv {
	const configKeys = new Set([
		"HOME",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
	]);
	const inheritedRuntimeEnv = Object.fromEntries(
		Object.entries(subprocessEnv()).filter(([key]) => !key.toUpperCase().startsWith("PI_") && !configKeys.has(key.toUpperCase())),
	);
	return {
		...inheritedRuntimeEnv,
		PI_CODING_AGENT_DIR: join(isolationRoot, "pi-agent"),
		PI_OFFLINE: "1",
		HOME: join(isolationRoot, "home"),
		USERPROFILE: join(isolationRoot, "user-profile"),
		APPDATA: join(isolationRoot, "app-data"),
		LOCALAPPDATA: join(isolationRoot, "local-app-data"),
		XDG_CONFIG_HOME: join(isolationRoot, "xdg-config"),
		XDG_DATA_HOME: join(isolationRoot, "xdg-data"),
		NO_UPDATE_NOTIFIER: "1",
	};
}

function runNpm(args: string[], cwd: string, timeoutMs: number) {
	const npmCli = process.env.npm_execpath;
	const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
	const commandArgs = npmCli ? [npmCli, ...args] : args;
	const result = spawnSync(command, commandArgs, {
		cwd,
		encoding: "utf8",
		env: subprocessEnv({ NO_UPDATE_NOTIFIER: "1" }),
		timeout: timeoutMs,
	});
	assert.equal(
		result.status,
		0,
		`npm ${args.join(" ")} failed (timeout=${timeoutMs}ms; status=${String(result.status)}; signal=${String(result.signal)}; error=${result.error?.message ?? "none"})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	return result;
}

type RpcResponse = {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: {
		commands?: Array<{
			name?: string;
			source?: string;
			sourceInfo?: { path?: string; source?: string; origin?: string };
		}>;
	};
	error?: string;
};

async function loadPackageCommandsWithPi(consumer: string, isolationRoot: string): Promise<RpcResponse> {
	const piCli = join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	const child = spawn(
		process.execPath,
		[
			piCli,
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--approve",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
		],
		{
			cwd: consumer,
			env: isolatedPiEnv(isolationRoot),
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	return new Promise((resolveResponse, reject) => {
		let stdout = "";
		let stdoutBuffer = "";
		let stderr = "";
		let response: RpcResponse | undefined;
		let teardownError: Error | undefined;
		let teardownStarted = false;
		let settled = false;
		const teardownTimers = new Set<NodeJS.Timeout>();

		const schedule = (callback: () => void, delayMs: number) => {
			const timer = setTimeout(() => {
				teardownTimers.delete(timer);
				callback();
			}, delayMs);
			teardownTimers.add(timer);
		};
		const clearTeardownTimers = () => {
			for (const timer of teardownTimers) clearTimeout(timer);
			teardownTimers.clear();
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTeardownTimers();
			clearTimeout(responseTimer);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			if (error) reject(error);
			else resolveResponse(response!);
		};
		const beginTeardown = (error?: Error) => {
			if (teardownStarted) return;
			teardownStarted = true;
			teardownError = error;
			child.stdin.end();

			schedule(() => {
				// On Windows, Node maps kill() to TerminateProcess; POSIX gets a
				// graceful SIGTERM before the final uncatchable escalation.
				child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				schedule(() => child.kill("SIGKILL"), PI_CHILD_TERM_GRACE_MS);
			}, PI_CHILD_STDIN_GRACE_MS);
			schedule(() => {
				const teardownMessage = `Pi child did not exit within the ${PI_CHILD_STDIN_GRACE_MS + PI_CHILD_TERM_GRACE_MS + PI_CHILD_KILL_GRACE_MS}ms teardown deadline`;
				finish(
					new Error(
						`${teardownError ? `${teardownError.message}\n` : ""}${teardownMessage}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
					),
				);
			}, PI_CHILD_STDIN_GRACE_MS + PI_CHILD_TERM_GRACE_MS + PI_CHILD_KILL_GRACE_MS);
		};
		const responseTimer = setTimeout(() => {
			beginTeardown(
				new Error(
					`Pi package response timed out after ${PI_PACKAGE_RESPONSE_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		}, PI_PACKAGE_RESPONSE_TIMEOUT_MS);

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (!line.trim()) continue;
				let event: RpcResponse;
				try {
					event = JSON.parse(line) as RpcResponse;
				} catch {
					continue;
				}
				if (event.type === "response" && event.id === "package-commands" && !teardownStarted) {
					response = event;
					beginTeardown();
				}
			}
		});
		child.on("error", (error) => beginTeardown(error));
		child.stdin.on("error", (error) => {
			if (!teardownStarted) beginTeardown(error);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			if (teardownStarted) {
				finish(teardownError);
				return;
			}
			finish(
				new Error(
					`Pi exited before reporting package commands (status=${String(code)}; signal=${String(signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
		child.stdin.write(`${JSON.stringify({ id: "package-commands", type: "get_commands" })}\n`);
	});
}

test("the package publish timeout covers every subprocess budget and filesystem cleanup", () => {
	assert.ok(
		PACKAGE_TEST_TIMEOUT_MS > BUDGETED_TEST_DURATION_MS,
		`outer timeout (${PACKAGE_TEST_TIMEOUT_MS}ms) must exceed pack (${PACK_TIMEOUT_MS}ms) + offline install (${OFFLINE_INSTALL_TIMEOUT_MS}ms) + consumer import (${CONSUMER_IMPORT_TIMEOUT_MS}ms) + Pi package load (${PI_PACKAGE_LOAD_TIMEOUT_MS}ms) + setup/cleanup (${SETUP_CLEANUP_MARGIN_MS}ms)`,
	);
});

test("package docs distinguish Pi 0.80.10 development validation from the 0.80.6 minimum", async () => {
	const [readme, contributing, operations, architecture] = await Promise.all(
		["README.md", "CONTRIBUTING.md", "docs/operations.md", "docs/architecture.md"].map((path) =>
			readFile(join(projectRoot, path), "utf8"),
		),
	);
	const combinedDocumentation = [readme, contributing, operations, architecture].join("\n");

	assert.doesNotMatch(combinedDocumentation, /\b0\.80\.7\b/);
	assert.doesNotMatch(combinedDocumentation, /pi -e \.\/extensions\/index\.ts -p ["']\/team["']/);
	assert.doesNotMatch(combinedDocumentation, /That smoke command exercises the shipped package entrypoint/);
	assert.match(readme, /This checks the source path only; it does not validate the compiled or published package entrypoint\./);
	assert.match(
		contributing,
		/Development validation uses exactly Pi `0\.80\.10`\. The supported host and worker minimum remains Pi `0\.80\.6`\.[\s\S]*Do not use `-p "\/team"` as an overlay check/,
	);
	assert.match(
		operations,
		/Check the source shim during development:[\s\S]*Check the compiled Pi entrypoint:[\s\S]*Check the published package contract/,
	);
	assert.match(
		operations,
		/Development validation uses exactly Pi `0\.80\.10`\. The supported host and worker minimum remains Pi `0\.80\.6`\./,
	);
	assert.match(
		architecture,
		/Repository development dependencies and validation use exactly Pi `0\.80\.10`\. The supported host and worker minimum remains Pi `0\.80\.6`\./,
	);
});

test("a clean publish artifact installs and imports in an offline consumer", { timeout: PACKAGE_TEST_TIMEOUT_MS }, async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-agents-team-publish-"));
	const cleanSource = join(temporaryRoot, "source");
	const artifacts = join(temporaryRoot, "artifacts");
	const consumer = join(temporaryRoot, "consumer");

	try {
		await Promise.all([mkdir(cleanSource), mkdir(artifacts), mkdir(consumer)]);

		for (const file of ["package.json", "README.md", "LICENSE", "tsconfig.json", "tsconfig.publish.json"]) {
			await cp(join(projectRoot, file), join(cleanSource, file));
		}
		for (const directory of ["extensions", "src", "prompts", "profiles", "scripts"]) {
			await cp(join(projectRoot, directory), join(cleanSource, directory), { recursive: true });
		}
		await symlink(join(projectRoot, "node_modules"), join(cleanSource, "node_modules"), "junction");
		assert.equal(existsSync(join(cleanSource, "dist")), false, "publish build must start without dist");

		runNpm(["pack", "--pack-destination", artifacts, "--ignore-scripts=false"], cleanSource, PACK_TIMEOUT_MS);
		const tarballs = (await readdir(artifacts)).filter((entry) => entry.endsWith(".tgz"));
		assert.equal(tarballs.length, 1, "npm pack should create exactly one tarball");

		await writeFile(
			join(consumer, "package.json"),
			JSON.stringify({
				name: "publish-contract-consumer",
				private: true,
				type: "module",
				dependencies: {
					"@earendil-works/pi-coding-agent": "0.80.6",
					"@earendil-works/pi-tui": "0.80.6",
				},
			}),
		);
		const tarball = join(artifacts, tarballs[0]!);
		runNpm(
			["install", "--offline", "--ignore-scripts", "--no-package-lock", "--no-save", tarball],
			consumer,
			OFFLINE_INSTALL_TIMEOUT_MS,
		);

		const installedPackage = join(consumer, "node_modules", "pi-agents-team");
		assert.equal(existsSync(join(installedPackage, "dist", "extensions", "index.js")), true);
		assert.equal(existsSync(join(installedPackage, "src")), false, "source must not leak into the package");
		const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as {
			version?: string;
		};
		const sourceManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
			version?: string;
		};
		assert.equal(installedManifest.version, sourceManifest.version);
		for (const piPackage of ["pi-coding-agent", "pi-tui"]) {
			const manifest = JSON.parse(
				await readFile(join(consumer, "node_modules", "@earendil-works", piPackage, "package.json"), "utf8"),
			) as { version?: string };
			assert.equal(manifest.version, "0.80.6", `${piPackage} consumer baseline drifted`);
		}

		const imported = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", 'import extension from "pi-agents-team"; if (typeof extension !== "function") process.exit(1)'],
			{ cwd: consumer, encoding: "utf8", timeout: CONSUMER_IMPORT_TIMEOUT_MS },
		);
		assert.equal(
			imported.status,
			0,
			`consumer import failed for ${basename(tarball)} (timeout=${CONSUMER_IMPORT_TIMEOUT_MS}ms; status=${String(imported.status)}; signal=${String(imported.signal)}; error=${imported.error?.message ?? "none"})\nstdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`,
		);

		const piIsolationRoot = join(temporaryRoot, "pi-isolation");
		await Promise.all([
			...[
				"pi-agent",
				"home",
				"user-profile",
				"app-data",
				"local-app-data",
				"xdg-config",
				"xdg-data",
			].map((directory) => mkdir(join(piIsolationRoot, directory), { recursive: true })),
			mkdir(join(consumer, ".pi")),
		]);
		await writeFile(
			join(consumer, ".pi", "settings.json"),
			JSON.stringify({ packages: [installedPackage] }),
		);
		const piResponse = await loadPackageCommandsWithPi(consumer, piIsolationRoot);
		assert.equal(piResponse.success, true, piResponse.error ?? "Pi get_commands failed");
		const extensionCommands = (piResponse.data?.commands ?? [])
			.filter((command) => command.source === "extension")
			.sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
		assert.deepEqual(
			extensionCommands.map((command) => command.name),
			EXPECTED_EXTENSION_COMMANDS,
			"Pi must execute the packed compiled factory and register its deterministic command surface",
		);
		const compiledEntry = join(installedPackage, "dist", "extensions", "index.js");
		for (const command of extensionCommands) {
			assert.equal(
				command.sourceInfo?.path,
				compiledEntry,
				`${command.name} must originate from the packed compiled entrypoint`,
			);
			assert.equal(command.sourceInfo?.source, installedPackage, `${command.name} must be loaded from the installed tarball`);
			assert.equal(command.sourceInfo?.origin, "package", `${command.name} must be discovered as a Pi package resource`);
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
