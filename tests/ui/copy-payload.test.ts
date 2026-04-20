import test from "node:test";
import assert from "node:assert/strict";
import { buildCopyPayload } from "../../src/ui/copy-payload";
import type { WorkerRuntimeState } from "../../src/types";

function makeWorker(): WorkerRuntimeState {
	return {
		workerId: "w3",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "idle",
		startedAt: 0,
		lastEventAt: 0,
		currentTask: {
			taskId: "t1",
			title: "Review rpc framing",
			goal: "Check JSONL strictness",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: "/repo",
			contextHints: ["focus on newline handling"],
			expectedOutput: "findings + risks",
			createdAt: 0,
		},
		lastSummary: {
			workerId: "w3",
			taskId: "t1",
			headline: "JSONL framing is strict",
			status: "idle",
			readFiles: ["src/runtime/rpc-client.ts"],
			changedFiles: [],
			risks: ["parser buffers unbounded on malformed stream"],
			nextRecommendation: "add a size cap",
			relayQuestionCount: 0,
			updatedAt: 0,
		},
		finalAnswer: "headline: all good\nfindings:\n- parser is strict",
		pendingRelayQuestions: [],
		usage: {
			turns: 3,
			inputTokens: 1200,
			outputTokens: 430,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.021,
		},
	};
}

test("buildCopyPayload includes task, summary, final answer, transcript, and console", () => {
	const worker = makeWorker();
	const transcript = "Here is the complete report…";
	const payload = buildCopyPayload(worker, transcript, [
		{ ts: 1_700_000_000_000, kind: "tool_start", text: "read src/runtime/rpc-client.ts" },
		{ ts: 1_700_000_001_000, kind: "status", text: "idle" },
	]);

	assert.match(payload, /# Worker w3/);
	assert.match(payload, /title: Review rpc framing/);
	assert.match(payload, /focus on newline handling/);
	assert.match(payload, /headline: JSONL framing is strict/);
	assert.match(payload, /parser buffers unbounded on malformed stream/);
	assert.match(payload, /turns=3\s+input=1200/);
	assert.match(payload, /## Final answer/);
	assert.match(payload, /headline: all good/);
	assert.match(payload, /## Latest assistant text[\s\S]*Here is the complete report/);
	assert.match(payload, /## Console timeline[\s\S]*\[tool_start\] read src\/runtime\/rpc-client\.ts/);
});

test("buildCopyPayload handles absent final answer and transcript cleanly", () => {
	const worker = makeWorker();
	worker.finalAnswer = undefined;
	const payload = buildCopyPayload(worker, undefined, undefined);
	assert.match(payload, /\(no <final_answer> block produced\)/);
	assert.match(payload, /\(no assistant text captured\)/);
	assert.doesNotMatch(payload, /## Console timeline/);
});
