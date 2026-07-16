import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	PERSISTED_TERMINAL_WORKER_STATUSES,
	type CompactPersistedWorker,
	type CompactPersistedWorkerSummary,
	type PersistedTerminalWorkerStatus,
} from "../../src/types.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;

type WorkerStatusContract = Assert<Equal<CompactPersistedWorker["status"], PersistedTerminalWorkerStatus>>;
type SummaryStatusContract = Assert<Equal<CompactPersistedWorkerSummary["status"], PersistedTerminalWorkerStatus>>;

// Keep the assertions live under noUnusedLocals if the test compiler enables it.
const typeContracts: [WorkerStatusContract, SummaryStatusContract] = [true, true];

// @ts-expect-error compact persisted workers reject runtime-only statuses
const invalidWorkerStatus: CompactPersistedWorker["status"] = "running";
// @ts-expect-error compact persisted summaries reject runtime-only statuses
const invalidSummaryStatus: CompactPersistedWorkerSummary["status"] = "waiting_followup";

void invalidWorkerStatus;
void invalidSummaryStatus;

const workerFields = {
	workerId: "w1",
	profileName: "fixer",
	startedAt: 1,
	lastEventAt: 2,
	usage: { turns: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
};
const summaryFields = {
	headline: "done",
	readFiles: [],
	changedFiles: [],
	risks: [],
	updatedAt: 2,
};
const validIdleWorker: CompactPersistedWorker = {
	...workerFields,
	status: "idle",
	lastSummary: { ...summaryFields, status: "idle" },
};
const validErrorWorker: CompactPersistedWorker = {
	...workerFields,
	status: "error",
	lastSummary: { ...summaryFields, status: "error" },
};
// @ts-expect-error worker and summary terminal statuses must be the same literal
const mismatchedTerminalWorker: CompactPersistedWorker = { ...workerFields, status: "idle", lastSummary: { ...summaryFields, status: "error" } };

void validIdleWorker;
void validErrorWorker;
void mismatchedTerminalWorker;

test("compact persisted status values match the wire reader terminal allowlist", () => {
	assert.deepEqual(PERSISTED_TERMINAL_WORKER_STATUSES, ["idle", "completed", "aborted", "error", "exited"]);
	assert.deepEqual(typeContracts, [true, true]);
});

test("normal test execution typechecks the compact persisted status contract", () => {
	const testPath = fileURLToPath(import.meta.url);
	const tscPath = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
	const result = spawnSync(process.execPath, [
		tscPath,
		"--ignoreConfig",
		"--noEmit",
		"--strict",
		"--skipLibCheck",
		"--target", "ES2022",
		"--module", "NodeNext",
		"--moduleResolution", "NodeNext",
		"--types", "node",
		testPath,
	], {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
	});
	assert.equal(
		result.status,
		0,
		`persisted status type contract failed to compile:\n${result.stdout}${result.stderr}`,
	);
});
