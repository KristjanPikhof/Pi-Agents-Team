import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	HOST_PI_VERSION,
	SUCCESSFUL_PROBE_CACHE_TTL_MS,
	buildPiVersionProbeCacheKey,
	clearPiVersionProbeCache,
	comparePiVersions,
	parsePiVersion,
	probeWorkerPiVersion,
	terminateWindowsProcessTree,
	type RunPiVersionCommand,
} from "../../src/runtime/pi-version";

function runner(result: { stdout?: string; stderr?: string; code?: number | null; error?: Error }): RunPiVersionCommand {
	return async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0, error: result.error });
}

test.beforeEach(() => clearPiVersionProbeCache());

test("uses the installed Pi package version as the host compatibility version", async () => {
	const installedPackage = JSON.parse(
		await readFile(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
	) as { version?: string };
	assert.equal(HOST_PI_VERSION, installedPackage.version);
});

test("parses supported Pi version output and compares semantic components", () => {
	assert.deepEqual(parsePiVersion("pi version v0.80.6\n"), { major: 0, minor: 80, patch: 6, prerelease: [], text: "0.80.6" });
	assert.ok(comparePiVersions(parsePiVersion("0.81.0")!, parsePiVersion("0.80.6")!) > 0);
	assert.ok(comparePiVersions(parsePiVersion("0.80.6-beta.1")!, parsePiVersion("0.80.6")!) < 0);
	assert.equal(parsePiVersion("not a Pi version"), undefined);
});

test("accepts the minimum, exact host, and newer worker versions but rejects prereleases below the stable floor", async () => {
	for (const output of ["0.80.6", "pi 0.80.6", "0.81.0", "1.0.0-beta.1"]) {
		clearPiVersionProbeCache();
		const result = await probeWorkerPiVersion({ command: "custom-pi", cwd: "/tmp" }, runner({ stdout: output }));
		assert.equal(result.supported, true, output);
	}
	for (const output of ["0.80.6-beta.1", "0.80.6-rc.1"]) {
		clearPiVersionProbeCache();
		const result = await probeWorkerPiVersion({ command: "custom-pi", cwd: "/tmp" }, runner({ stdout: output }));
		assert.equal(result.supported, false, output);
		assert.match(result.message ?? "", /require Pi 0\.80\.6 or newer/);
	}
});

test("rejects old, malformed, and missing worker versions with actionable diagnostics", async () => {
	const cases = [
		{ result: { stdout: "0.80.5" }, pattern: /Pi 0\.80\.5.*require Pi 0\.80\.6 or newer.*rpc\.command/ },
		{ result: { stdout: "nightly" }, pattern: /unparseable version.*0\.80\.6 or newer.*rpc\.command/ },
		{ result: { code: null, error: new Error("spawn ENOENT") }, pattern: /failed to run custom-pi --version.*ENOENT.*0\.80\.6 or newer.*rpc\.command/ },
	];
	for (const entry of cases) {
		clearPiVersionProbeCache();
		const result = await probeWorkerPiVersion({ command: "custom-pi", cwd: "/tmp" }, runner(entry.result));
		assert.equal(result.supported, false);
		assert.match(result.message ?? "", entry.pattern);
	}
});

test("reports supported host/worker mismatch but not an exact match", async () => {
	const exact = await probeWorkerPiVersion({ command: "exact", cwd: "/tmp" }, runner({ stdout: HOST_PI_VERSION }));
	const mismatch = await probeWorkerPiVersion({ command: "newer", cwd: "/tmp" }, runner({ stdout: "0.81.0" }));
	assert.equal(exact.mismatch, false);
	assert.equal(mismatch.mismatch, true);
	assert.equal(mismatch.workerVersion, "0.81.0");
});

test("caches probes and coalesces concurrent first probes by command", async () => {
	let calls = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const run: RunPiVersionCommand = async () => {
		calls += 1;
		await blocked;
		return { stdout: "0.80.6", stderr: "", code: 0 };
	};
	const options = { command: "coalesced-pi", cwd: "/tmp" };
	const first = probeWorkerPiVersion(options, run);
	const second = probeWorkerPiVersion(options, run);
	assert.equal(calls, 1);
	release();
	assert.strictEqual(await first, await second);
	await probeWorkerPiVersion(options, run);
	assert.equal(calls, 1);
});

test("expires successful cache entries while continuing to coalesce pending probes", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	const run: RunPiVersionCommand = async () => {
		calls += 1;
		return { stdout: calls === 1 ? "0.80.6" : "0.81.0", stderr: "", code: 0 };
	};
	const options = { command: "ttl-pi", cwd: "/tmp" };
	assert.equal((await probeWorkerPiVersion(options, run)).workerVersion, "0.80.6");
	now += SUCCESSFUL_PROBE_CACHE_TTL_MS - 1;
	assert.equal((await probeWorkerPiVersion(options, run)).workerVersion, "0.80.6");
	now += 1;
	assert.equal((await probeWorkerPiVersion(options, run)).workerVersion, "0.81.0");
	assert.equal(calls, 2);
});

test("does not retain raw environment or CLI credential values in cache keys", () => {
	const secret = "credential-value-that-must-not-be-retained";
	const first = buildPiVersionProbeCacheKey("missing-pi", ["--token", secret, "--version"], "/tmp", {
		PATH: "/credential/path",
		API_TOKEN: secret,
	});
	const second = buildPiVersionProbeCacheKey("missing-pi", ["--token", secret, "--version"], "/tmp", {
		PATH: "/credential/path",
		API_TOKEN: `${secret}-changed`,
	});
	assert.doesNotMatch(first, /credential-value|API_TOKEN|credential\/path/);
	assert.notEqual(first, second);
});

test("invalidates a successful probe when the resolved executable is replaced", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-version-replace-"));
	const executable = join(root, "pi");
	const replacement = join(root, "pi-new");
	await writeFile(executable, "first");
	let calls = 0;
	const run: RunPiVersionCommand = async () => {
		calls += 1;
		return { stdout: calls === 1 ? "0.80.6" : "0.81.0", stderr: "", code: 0 };
	};
	try {
		assert.equal((await probeWorkerPiVersion({ command: executable, cwd: root }, run)).workerVersion, "0.80.6");
		await writeFile(replacement, "second executable");
		await rename(replacement, executable);
		assert.equal((await probeWorkerPiVersion({ command: executable, cwd: root }, run)).workerVersion, "0.81.0");
		assert.equal(calls, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows taskkill cleanup falls back on failure and kills a hung taskkill", async () => {
	class FakeChild extends EventEmitter {
		pid = 123;
		killCalls = 0;
		kill(): boolean {
			this.killCalls += 1;
			return true;
		}
	}

	const failedChild = new FakeChild();
	const failedKiller = new FakeChild();
	await terminateWindowsProcessTree(failedChild, () => {
		queueMicrotask(() => failedKiller.emit("close", 1));
		return failedKiller;
	}, 50);
	assert.equal(failedChild.killCalls, 1);
	assert.equal(failedKiller.killCalls, 0);

	const hungChild = new FakeChild();
	const hungKiller = new FakeChild();
	await terminateWindowsProcessTree(hungChild, () => hungKiller, 10);
	assert.equal(hungKiller.killCalls, 1);
	assert.equal(hungChild.killCalls, 1);
});

test("preserves arbitrary value-taking wrapper options through the explicit Pi RPC boundary", async () => {
	const wrapperPrefixes = [
		["--enable-source-maps"],
		["--env-file", "/tmp/worker.env"],
		["--env-file-if-exists", "/tmp/optional.env"],
		["--require", "/tmp/register.cjs"],
		["--loader", "tsx"],
		["--conditions", "development"],
		["--inspect-port", "9330"],
	];
	for (const wrapperArgs of wrapperPrefixes) {
		clearPiVersionProbeCache();
		let observed: string[] = [];
		const cliEntry = "/tmp/pi-cli.js";
		await probeWorkerPiVersion(
			{
				command: process.execPath,
				baseArgs: [...wrapperArgs, cliEntry, "--mode", "rpc", "--no-session"],
				cwd: "/tmp",
			},
			async ({ args }) => {
				observed = args;
				return { stdout: "0.80.6", stderr: "", code: 0 };
			},
		);
		assert.deepEqual(observed, [...wrapperArgs, cliEntry, "--version"]);
	}
});

test("real node --env-file wrapper probes the installed Pi CLI rather than Node", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-version-env-file-"));
	const envFile = join(root, "worker.env");
	const piCli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	await writeFile(envFile, "PI_VERSION_PROBE_REGRESSION=1\n");
	try {
		const result = await probeWorkerPiVersion({
			command: process.execPath,
			baseArgs: ["--env-file", envFile, piCli, "--mode", "rpc", "--no-session"],
			cwd: process.cwd(),
		});
		assert.deepEqual(result.versionArgs, ["--env-file", envFile, piCli, "--version"]);
		assert.equal(result.workerVersion, HOST_PI_VERSION);
		assert.notEqual(result.workerVersion, process.version.replace(/^v/, ""));
		assert.equal(result.supported, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keys bare-command probes by the executable resolved from cwd and PATH", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-version-path-"));
	const firstBin = join(root, "first");
	const secondBin = join(root, "second");
	await mkdir(firstBin);
	await mkdir(secondBin);
	await writeFile(join(firstBin, "pi"), "first");
	await writeFile(join(secondBin, "pi"), "second");
	let calls = 0;
	const run: RunPiVersionCommand = async ({ env }) => {
		calls += 1;
		return { stdout: env?.PATH?.startsWith(firstBin) ? "0.80.6" : "0.81.0", stderr: "", code: 0 };
	};
	try {
		const first = await probeWorkerPiVersion({ command: "pi", cwd: root, env: { PATH: `${firstBin}${delimiter}/usr/bin` } }, run);
		const second = await probeWorkerPiVersion({ command: "pi", cwd: root, env: { PATH: `${secondBin}${delimiter}/usr/bin` } }, run);
		assert.equal(first.workerVersion, "0.80.6");
		assert.equal(second.workerVersion, "0.81.0");
		assert.equal(calls, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("does not cache failed probes so an operator can fix the executable and retry", async () => {
	let calls = 0;
	const run: RunPiVersionCommand = async () => {
		calls += 1;
		return calls === 1
			? { stdout: "", stderr: "spawn failed", code: 1 }
			: { stdout: "0.80.6", stderr: "", code: 0 };
	};
	const options = { command: "repairable-pi", cwd: "/tmp" };
	assert.equal((await probeWorkerPiVersion(options, run)).supported, false);
	assert.equal((await probeWorkerPiVersion(options, run)).supported, true);
	assert.equal(calls, 2);
});

test("bounds and terminates a hanging real version probe and truncates diagnostics", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-version-hang-"));
	const script = join(root, "hanging-cli.mjs");
	await writeFile(script, "setInterval(() => {}, 1000);\n");
	try {
		const startedAt = Date.now();
		const hung = await probeWorkerPiVersion({
			command: process.execPath,
			baseArgs: [script, "--mode", "rpc"],
			cwd: root,
			timeoutMs: 40,
		});
		assert.equal(hung.supported, false);
		assert.match(hung.message ?? "", /timed out after 40ms/);
		assert.ok(Date.now() - startedAt < 2_000);

		const noisy = await probeWorkerPiVersion(
			{ command: "noisy-pi", cwd: root },
			runner({ stdout: "x".repeat(10_000) }),
		);
		assert.equal(noisy.supported, false);
		assert.match(noisy.message ?? "", /\[truncated\]/);
		assert.ok((noisy.message ?? "").length < 1_000);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
