import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerProcessArgs } from "../../src/runtime/worker-process";

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
