import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	HOST_PI_VERSION,
	clearPiVersionProbeCache,
	comparePiVersions,
	parsePiVersion,
	probeWorkerPiVersion,
	type RunPiVersionCommand,
} from "../../src/runtime/pi-version";

function runner(result: { stdout?: string; stderr?: string; code?: number | null; error?: Error }): RunPiVersionCommand {
	return async () => ({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0, error: result.error });
}

test.beforeEach(() => clearPiVersionProbeCache());

test("uses Pi's exported VERSION as the host compatibility version", () => {
	assert.equal(HOST_PI_VERSION, "0.80.6");
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

test("keeps wrapper options and the custom CLI entrypoint while replacing Pi RPC flags with --version", async () => {
	let observed: string[] = [];
	await probeWorkerPiVersion(
		{
			command: process.execPath,
			baseArgs: ["--enable-source-maps", "dist/cli.js", "--mode", "rpc", "--no-session"],
			cwd: "/tmp",
		},
		async ({ args }) => {
			observed = args;
			return { stdout: "0.80.6", stderr: "", code: 0 };
		},
	);
	assert.deepEqual(observed, ["--enable-source-maps", "dist/cli.js", "--version"]);
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
