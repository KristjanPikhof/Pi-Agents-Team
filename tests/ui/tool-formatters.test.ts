import test from "node:test";
import assert from "node:assert/strict";
import {
	TOOL_SECTION_LABELS,
	formatDelegateTaskResult,
	formatWaitForAgentsResult,
	formatWorkerCompact,
	formatWorkerDetail,
	formatWorkers,
	truncateList,
} from "../../src/ui/tool-formatters";
import type { WorkerRuntimeState } from "../../src/types";

function makeWorker(overrides: Partial<WorkerRuntimeState> = {}): WorkerRuntimeState {
	return {
		workerId: "w1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "idle",
		requestedThinkingLevel: "minimal",
		effectiveThinkingLevel: "minimal",
		startedAt: 1,
		lastEventAt: 2,
		pendingRelayQuestions: [],
		usage: { turns: 1, inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 },
		...overrides,
	};
}

test("shared labels define the scan order vocabulary for tool results", () => {
	assert.equal(TOOL_SECTION_LABELS.worker, "Worker");
	assert.equal(TOOL_SECTION_LABELS.status, "Status");
	assert.equal(TOOL_SECTION_LABELS.resultReason, "Result reason");
	assert.equal(TOOL_SECTION_LABELS.relayQuestions, "Pending relay questions");
	assert.equal(TOOL_SECTION_LABELS.finalAnswer, "--- Final answer (from worker's <final_answer> block) ---");
});

test("formatWorkerDetail orders identity, task metadata, summary, relay, usage, final answer, transcript", () => {
	const worker = makeWorker({
		currentTask: {
			taskId: "t1",
			title: "Implement foundation",
			goal: "Share formatter seams",
			requestedBy: "orchestrator",
			profileName: "fixer",
			cwd: "/repo",
			contextHints: [],
			pathScope: { roots: ["/repo/src"], allowReadOutsideRoots: false, allowWrite: true },
			createdAt: 3,
		},
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "Foundation added",
			status: "idle",
			readFiles: ["src/a.ts"],
			changedFiles: ["src/b.ts"],
			risks: ["none"],
			nextRecommendation: "tool lanes can consume helpers",
			relayQuestionCount: 0,
			updatedAt: 4,
		},
		pendingRelayQuestions: [{ relayId: "r1", workerId: "w1", taskId: "t1", question: "Proceed?", assumption: "yes", urgency: "medium", createdAt: 5 }],
		finalAnswer: "done",
	});

	const text = formatWorkerDetail(worker, { transcript: "assistant tail" });
	const ordered = [
		"Worker: w1",
		"Profile: fixer",
		"Status: idle",
		"Task: Implement foundation",
		"Goal: Share formatter seams",
		"CWD: /repo",
		"Path scope: read/write /repo/src",
		"Headline: Foundation added",
		"Read files: src/a.ts",
		"Changed files: src/b.ts",
		"Risks: none",
		"Next: tool lanes can consume helpers",
		"Pending relay questions:",
		"Usage: turns=1 input=1.2k output=3.4k cost=$0.0123",
		"--- Final answer (from worker's <final_answer> block) ---",
		"--- Latest assistant text ---",
	];
	let lastIndex = -1;
	for (const part of ordered) {
		const index = text.indexOf(part);
		assert.ok(index > lastIndex, `expected ${part} after previous section`);
		lastIndex = index;
	}
});

test("formatWorkerCompact truncates summary lists but preserves final_answer verbatim", () => {
	const worker = makeWorker({
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "Many files",
			status: "idle",
			readFiles: Array.from({ length: 12 }, (_, i) => `read-${i}.ts`),
			changedFiles: [],
			risks: ["r1", "r2", "r3", "r4", "r5", "r6"],
			relayQuestionCount: 0,
			updatedAt: 6,
		},
		finalAnswer: "line 1\nline 2",
	});
	const text = formatWorkerCompact(worker);
	assert.match(text, /Read files: read-0\.ts, read-1\.ts, read-2\.ts, read-3\.ts, read-4\.ts, read-5\.ts, read-6\.ts, read-7\.ts, read-8\.ts, read-9\.ts… \(\+2 more\)/);
	assert.match(text, /Risks: r1, r2, r3, r4, r5… \(\+1 more\)/);
	assert.match(text, /--- Final answer \(from worker's <final_answer> block\) ---\nline 1\nline 2/);
});

test("wait formatter preserves reason wording, relay formatting, and worker list shape", () => {
	const text = formatWaitForAgentsResult({
		reason: "relay_raised",
		workers: [makeWorker({ status: "running", currentTask: { taskId: "t1", title: "Question task", goal: "Ask", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } })],
		newRelays: [{ workerId: "w1", profileName: "fixer", urgency: "high", question: "Need scope?" }],
	});
	assert.match(text, /^1 new relay question\(s\) raised — answer via agent_message, then call wait_for_agents again to resume\./);
	assert.match(text, /  ! w1 \(fixer\) \[high\] Need scope\?/);
	assert.match(text, /- w1 \(fixer\) · status=running · task=Question task/);
});

test("small helpers preserve existing delegate and list contracts", () => {
	const worker = makeWorker();
	assert.equal(formatDelegateTaskResult("Build seam", worker), "Delegated Build seam to fixer as w1.");
	assert.equal(formatWorkers([]), "No active or persisted workers.");
	assert.equal(truncateList(["a", "b", "c"], 2), "a, b… (+1 more)");
});
