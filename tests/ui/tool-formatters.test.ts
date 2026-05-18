import test from "node:test";
import assert from "node:assert/strict";
import {
	TOOL_SECTION_LABELS,
	formatAgentMessageResult,
	formatDelegateTaskResult,
	formatWaitForAgentsResult,
	formatWorkerCompact,
	formatWorkerDetail,
	formatWorkers,
	truncateList,
} from "../../src/ui/tool-formatters";
import type { WorkerRuntimeState } from "../../src/types";
import { stripAnsi } from "../../src/ui/theme";

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
	assert.equal(TOOL_SECTION_LABELS.wait, "Wait");
	assert.equal(TOOL_SECTION_LABELS.relayQuestions, "Pending relay questions");
	assert.equal(TOOL_SECTION_LABELS.readFiles, "Read files (readFiles/files_read)");
	assert.equal(TOOL_SECTION_LABELS.changedFiles, "Changed files (changedFiles/files_changed)");
	assert.equal(TOOL_SECTION_LABELS.finalAnswer, "Result");
});

test("formatWorkerDetail keeps only title, task, relay, and result", () => {
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
	assert.match(text, /^\x1b\[1mfixer\x1b\[0m \(w1\)/);
	const plain = stripAnsi(text);
	const ordered = [
		"fixer (w1)",
		"Task: Implement foundation",
		"Pending relay questions:",
		"Result:\ndone",
	];
	let lastIndex = -1;
	for (const part of ordered) {
		const index = plain.indexOf(part);
		assert.ok(index > lastIndex, `expected ${part} after previous section`);
		lastIndex = index;
	}
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /^Profile:/m);
	assert.doesNotMatch(plain, /^Status: idle/m);
	assert.doesNotMatch(plain, /^Goal:/m);
	assert.doesNotMatch(plain, /^CWD:/m);
	assert.doesNotMatch(plain, /^Path scope:/m);
	assert.doesNotMatch(plain, /^Headline:/m);
	assert.doesNotMatch(plain, /^Read files/m);
	assert.doesNotMatch(plain, /^Changed files/m);
	assert.doesNotMatch(plain, /^Risks:/m);
	assert.doesNotMatch(plain, /^Usage:/m);
	assert.doesNotMatch(plain, /Latest assistant text/);
});

test("formatWorkerCompact suppresses summary lists but preserves final_answer verbatim", () => {
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
	assert.doesNotMatch(text, /Read files/);
	assert.doesNotMatch(text, /Risks:/);
	assert.match(text, /Result:\nline 1\nline 2/);
});

test("formatWorkerCompact makes normal agent_result sections scannable without transcript", () => {
	const worker = makeWorker({
		status: "completed",
		currentTask: { taskId: "t1", title: "Render result", goal: "Improve output", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 },
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "Renderer improved",
			status: "completed",
			readFiles: ["src/ui/tool-formatters.ts"],
			changedFiles: ["tests/ui/tool-formatters.test.ts"],
			risks: ["none"],
			nextRecommendation: "reviewer to spot-check output",
			relayQuestionCount: 0,
			updatedAt: 2,
		},
		finalAnswer: "headline: renderer improved\nverification: npm test passed",
	});
	const text = formatWorkerCompact(worker);
	assert.match(text, /^\x1b\[1mfixer\x1b\[0m \(w1\)/);
	const plain = stripAnsi(text);
	for (const part of [
		"fixer (w1)",
		"Task: Render result",
		"Result:\nheadline: renderer improved\nverification: npm test passed",
	]) assert.match(plain, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /^Status: completed/m);
	assert.doesNotMatch(plain, /^Headline:/m);
	assert.doesNotMatch(plain, /^Read files/m);
	assert.doesNotMatch(plain, /^Changed files/m);
	assert.doesNotMatch(plain, /^Risks:/m);
	assert.doesNotMatch(plain, /^Usage:/m);
	assert.doesNotMatch(plain, /Latest assistant text/);
});

test("formatWorkerCompact shows concise no-final and thin-final output", () => {
	const noFinal = formatWorkerCompact(makeWorker());
	assert.match(noFinal, /Result:\nNo <final_answer> block extracted yet/);

	const thin = formatWorkerCompact(makeWorker({ finalAnswer: "done" }));
	assert.doesNotMatch(thin, /very short final_answer/);
	assert.match(thin, /Result:\ndone/);
});

test("formatWorkerCompact surfaces error workers, pending relays, aliases, and usage context", () => {
	const worker = makeWorker({
		status: "error",
		error: "worker crashed",
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "Summary alias accepted",
			status: "error",
			readFiles: ["src/from-files-read.ts"],
			changedFiles: ["src/from-changed-files.ts"],
			risks: ["crash prevented completion"],
			relayQuestionCount: 1,
			updatedAt: 2,
		},
		pendingRelayQuestions: [{ relayId: "r1", workerId: "w1", taskId: "t1", question: "Retry with smaller scope?", assumption: "Yes", urgency: "high", createdAt: 3 }],
		usage: { turns: 2, inputTokens: 1500, outputTokens: 2500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, contextTokens: 128000, contextWindow: 200000, contextPercent: 64, contextRemainingTokens: 72000 },
	});
	const text = formatWorkerCompact(worker);
	assert.match(text, /Error: worker crashed/);
	assert.doesNotMatch(text, /Read files/);
	assert.doesNotMatch(text, /Changed files/);
	assert.match(text, /Pending relay questions:\n- \[high\] Retry with smaller scope\?\n  assumption: Yes/);
	assert.doesNotMatch(text, /^Usage:/m);
	assert.doesNotMatch(text, /^Context:/m);
});

test("wait formatter makes all_terminal outcome and next action scannable", () => {
	const text = formatWaitForAgentsResult({
		reason: "all_terminal",
		workers: [
			makeWorker({ status: "completed", currentTask: { taskId: "t1", title: "Done task", goal: "Finish", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } }),
			makeWorker({ workerId: "w2", status: "idle", profileName: "reviewer" }),
		],
	});
	assert.match(text, /^Wait: all_terminal\nDone: 2 agent\(s\) finished or stopped\./);
	assert.match(text, /Next: read results with agent_result\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=completed \(Completed\) · task=Done task\n- w2 \(reviewer\) · status=idle \(Idle\)/);
});

test("wait formatter makes relay questions copyable with agent_message and follow-up wait", () => {
	const text = formatWaitForAgentsResult({
		reason: "relay_raised",
		workers: [makeWorker({ status: "running", currentTask: { taskId: "t1", title: "Question task", goal: "Ask", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } })],
		newRelays: [{ workerId: "w1", profileName: "fixer", urgency: "high", question: "Need scope?" }],
	});
	assert.match(text, /^Wait: relay_raised\nNeeds reply: 1 relay question\(s\)\./);
	assert.match(text, /Pending relay questions:\n1\. fixer \(w1\) \[high\]\n   Need scope\?/);
	assert.match(text, /Next: answer with agent_message, then wait again for \["w1"\]\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running \(Running\) · task=Question task/);
});

test("wait formatter distinguishes timeout with mixed worker statuses", () => {
	const text = formatWaitForAgentsResult({
		reason: "timeout",
		workers: [makeWorker({ status: "running" }), makeWorker({ workerId: "w2", profileName: "reviewer", status: "completed" })],
	});
	assert.match(text, /^Wait: timeout\nTimed out: some agents are still running\./);
	assert.match(text, /Next: wait again or inspect status\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running \(Running\)\n- w2 \(reviewer\) · status=completed \(Completed\)/);
});

test("wait formatter distinguishes aborted waits", () => {
	const text = formatWaitForAgentsResult({
		reason: "aborted",
		workers: [makeWorker({ status: "running" })],
	});
	assert.match(text, /^Wait: aborted\nCancelled: wait stopped before all agents finished\./);
	assert.match(text, /Next: inspect status or cancel unwanted agents\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running \(Running\)/);
});

test("wait formatter explains no_workers wrapper outcome", () => {
	const text = formatWaitForAgentsResult({ reason: "no_workers", workers: [] });
	assert.equal(text, "Wait: no_workers\nNo agents to wait for.\nNext: delegate a task first.");
});

test("delegate formatter makes fresh launch lifecycle scannable", () => {
	const task = {
		taskId: "t1",
		title: "Build seam",
		goal: "Wire shared formatter",
		requestedBy: "orchestrator" as const,
		profileName: "fixer",
		cwd: "/repo",
		contextHints: [],
		pathScope: { roots: ["/repo/src", "/repo/tests"], allowReadOutsideRoots: false, allowWrite: true },
		createdAt: 3,
	};
	const worker = makeWorker({ status: "running", currentTask: task });
	const text = formatDelegateTaskResult({ worker, task });

	const plain = stripAnsi(text);
	assert.equal(plain, "Created fixer (w1)\nTask: Build seam (t1)\nNext: wait_for_agents workerIds=[\"w1\"]");
});

test("delegate formatter shows reuse state with same worker and new task", () => {
	const task = {
		taskId: "t2",
		title: "Follow-up fix",
		goal: "Reuse the warm worker",
		requestedBy: "orchestrator" as const,
		profileName: "fixer",
		cwd: "/repo",
		contextHints: [],
		createdAt: 4,
	};
	const worker = makeWorker({ status: "running", currentTask: task });
	const text = formatDelegateTaskResult({ worker, task, reuseWorkerId: "w1" });

	const plain = stripAnsi(text);
	assert.match(plain, /^Reusing fixer \(w1\)/);
	assert.match(plain, /Task: Follow-up fix \(t2\)/);
	assert.doesNotMatch(plain, /Lifecycle:/);
	assert.match(plain, /Next: wait_for_agents workerIds=\["w1"\]/);
});

test("agent message formatter names resolved delivery and wake/resume cases", () => {
	const worker = makeWorker({ status: "running" });
	assert.equal(formatAgentMessageResult({ worker, delivery: "steer", previousStatus: "running" }), "Steering running agent fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "follow_up", previousStatus: "running" }), "Queued follow-up for fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "prompt", previousStatus: "idle" }), "Waking idle agent fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "prompt", previousStatus: "waiting_followup" }), "Resuming agent fixer (w1).");
});

test("small helpers preserve list contracts", () => {
	assert.equal(formatWorkers([]), "No active or persisted workers.");
	assert.equal(truncateList(["a", "b", "c"], 2), "a, b… (+1 more)");
});
