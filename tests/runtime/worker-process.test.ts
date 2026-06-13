import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerProcessArgs, resolveWorkerSpawnImplementation } from "../../src/runtime/worker-process";

test("buildWorkerProcessArgs maps trusted project decision to --approve", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd(), projectTrust: "approve" });
	assert.ok(args.includes("--approve"));
	assert.ok(!args.includes("--no-approve"));
});

test("buildWorkerProcessArgs maps untrusted project decision to --no-approve", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd(), projectTrust: "no-approve" });
	assert.ok(args.includes("--no-approve"));
	assert.ok(!args.includes("--approve"));
});

test("buildWorkerProcessArgs omits project trust flags when decision is unknown", () => {
	const args = buildWorkerProcessArgs({ cwd: process.cwd() });
	assert.ok(!args.includes("--approve"));
	assert.ok(!args.includes("--no-approve"));
});

test("buildWorkerProcessArgs preserves configured base args before launch flags", () => {
	const args = buildWorkerProcessArgs({
		cwd: process.cwd(),
		baseArgs: ["node", "dist/cli.js", "--mode", "rpc", "--no-session"],
		projectTrust: "approve",
		model: "provider/model",
	});

	assert.deepEqual(args.slice(0, 5), ["node", "dist/cli.js", "--mode", "rpc", "--no-session"]);
	assert.deepEqual(args.slice(5), ["--approve", "--model", "provider/model"]);
});

test("resolveWorkerSpawnImplementation uses cross-spawn on Windows", () => {
	assert.equal(resolveWorkerSpawnImplementation("win32"), "cross-spawn");
	assert.equal(resolveWorkerSpawnImplementation("darwin"), "node:child_process");
	assert.equal(resolveWorkerSpawnImplementation("linux"), "node:child_process");
});
