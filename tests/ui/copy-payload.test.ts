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
			cacheReadTokens: 5_600,
			cacheWriteTokens: 78,
			costUsd: 0.021,
		},
	};
}

test("buildCopyPayload includes task, summary, final answer, transcript, activity, and raw console", () => {
	const worker = makeWorker();
	const transcript = "Here is the complete report…";
	const payload = buildCopyPayload(worker, transcript, [
		{ ts: 1_700_000_000_000, kind: "tool_start", text: "read src/runtime/rpc-client.ts" },
		{ ts: 1_700_000_001_000, kind: "tool_end", text: "read → export function buildCopyPayload()\n… +4 lines hidden" },
		{ ts: 1_700_000_002_000, kind: "status", text: "idle" },
	]);

	assert.match(payload, /# Worker w3/);
	assert.match(payload, /title: Review rpc framing/);
	assert.match(payload, /focus on newline handling/);
	assert.match(payload, /headline: JSONL framing is strict/);
	assert.match(payload, /parser buffers unbounded on malformed stream/);
	assert.match(payload, /turns=3\s+input=1200\s+output=430\s+cache_read=5600\s+cache_write=78\s+cost_usd=0\.0210/);
	assert.match(payload, /## Final answer/);
	assert.match(payload, /headline: all good/);
	assert.match(payload, /## Latest assistant text[\s\S]*Here is the complete report/);
	assert.match(payload, /## Activity[\s\S]*• Ran read src\/runtime\/rpc-client\.ts[\s\S]*export function buildCopyPayload\(\)[\s\S]*… \+4 lines hidden/);
	assert.match(payload, /• Final answer[\s\S]*Headline: all good/);
	assert.match(payload, /## Console timeline \(Raw\)[\s\S]*\[2023-11-14T22:13:20\.000Z\] \[tool_start\] read src\/runtime\/rpc-client\.ts/);
	assert.match(payload, /## Console timeline \(Raw\)[\s\S]*\[tool_end\] read → export function buildCopyPayload\(\)\n… \+4 lines hidden/);
});

test("buildCopyPayload handles absent final answer and transcript cleanly", () => {
	const worker = makeWorker();
	worker.finalAnswer = undefined;
	const payload = buildCopyPayload(worker, undefined, undefined);
	assert.match(payload, /\(no <final_answer> block produced\)/);
	assert.match(payload, /\(no assistant text captured\)/);
	assert.match(payload, /## Activity\n\(no activity captured\)/);
	assert.doesNotMatch(payload, /## Console timeline \(Raw\)/);
});

test("buildCopyPayload uses provided worker activity events before raw diagnostics", () => {
	const worker = makeWorker();
	worker.finalAnswer = undefined;
	const payload = buildCopyPayload(worker, undefined, [
		{ ts: 1_700_000_000_000, kind: "tool_start", text: "bash {\"command\":\"npm test\"}" },
	], [
		{
			id: "a1",
			ts: 1_700_000_000_000,
			updatedAt: 1_700_000_000_500,
			actionKind: "command",
			status: "completed",
			label: "Ran npm test",
			summary: "npm test",
			command: "npm test",
			outputSnippet: "12/12 passing",
			hiddenLineCount: 8,
			sourceEvent: "worker_tool_finished",
		},
	]);

	assert.match(payload, /## Activity[\s\S]*• Ran npm test[\s\S]*12\/12 passing[\s\S]*… \+8 lines hidden/);
	assert.match(payload, /## Console timeline \(Raw\)[\s\S]*\[tool_start\] bash/);
	assert.ok(payload.indexOf("## Activity") < payload.indexOf("## Console timeline (Raw)"));
});

test("buildCopyPayload omits cache fields when both cache counters are zero", () => {
	const worker = makeWorker();
	worker.usage.cacheReadTokens = 0;
	worker.usage.cacheWriteTokens = 0;
	const payload = buildCopyPayload(worker, undefined, undefined);
	assert.match(payload, /turns=3\s+input=1200\s+output=430\s+cost_usd=0\.0210/);
	assert.doesNotMatch(payload, /cache_read|cache_write/);
});
