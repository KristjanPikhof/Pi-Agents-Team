import test from "node:test";
import assert from "node:assert/strict";
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
	assert.deepEqual(parsePiVersion("pi version v0.80.6\n"), { major: 0, minor: 80, patch: 6, text: "0.80.6" });
	assert.ok(comparePiVersions(parsePiVersion("0.81.0")!, parsePiVersion("0.80.6")!) > 0);
	assert.equal(parsePiVersion("not a Pi version"), undefined);
});

test("accepts the minimum, exact host, and newer worker versions", async () => {
	for (const output of ["0.80.6", "pi 0.80.6", "0.81.0", "1.0.0-beta.1"]) {
		clearPiVersionProbeCache();
		const result = await probeWorkerPiVersion({ command: "custom-pi", cwd: "/tmp" }, runner({ stdout: output }));
		assert.equal(result.supported, true, output);
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

test("keeps custom CLI entrypoint args while replacing RPC flags with --version", async () => {
	let observed: string[] = [];
	await probeWorkerPiVersion(
		{ command: process.execPath, baseArgs: ["dist/cli.js", "--mode", "rpc", "--no-session"], cwd: "/tmp" },
		async ({ args }) => {
			observed = args;
			return { stdout: "0.80.6", stderr: "", code: 0 };
		},
	);
	assert.deepEqual(observed, ["dist/cli.js", "--version"]);
});
