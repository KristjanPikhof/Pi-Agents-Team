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
	assert.equal(TOOL_SECTION_LABELS.readFiles, "Read files (readFiles/files_read)");
	assert.equal(TOOL_SECTION_LABELS.changedFiles, "Changed files (changedFiles/files_changed)");
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
		"Read files (readFiles/files_read): src/a.ts",
		"Changed files (changedFiles/files_changed): src/b.ts",
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
	assert.match(text, /Read files \(readFiles\/files_read\): read-0\.ts, read-1\.ts, read-2\.ts, read-3\.ts, read-4\.ts, read-5\.ts, read-6\.ts, read-7\.ts, read-8\.ts, read-9\.ts… \(\+2 more\)/);
	assert.match(text, /Risks: r1, r2, r3, r4, r5… \(\+1 more\)/);
	assert.match(text, /--- Final answer \(from worker's <final_answer> block\) ---\nline 1\nline 2/);
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
	for (const part of [
		"Worker: w1 (fixer)",
		"Status: completed",
		"Task: Render result",
		"Headline: Renderer improved",
		"Read files (readFiles/files_read): src/ui/tool-formatters.ts",
		"Changed files (changedFiles/files_changed): tests/ui/tool-formatters.test.ts",
		"Risks: none",
		"Next: reviewer to spot-check output",
		"Usage: turns=1 input=1200 output=3400 cost=$0.0123",
		"--- Final answer (from worker's <final_answer> block) ---\nheadline: renderer improved\nverification: npm test passed",
	]) assert.match(text, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(text, /Latest assistant text/);
});

test("formatWorkerCompact shows no-final and thin-final guidance", () => {
	const noFinal = formatWorkerCompact(makeWorker());
	assert.match(noFinal, /--- Final answer \(from worker's <final_answer> block\) ---\nNo <final_answer> block extracted yet/);

	const thin = formatWorkerCompact(makeWorker({ finalAnswer: "done" }));
	assert.match(thin, /Final answer note: very short final_answer \(1 word\); verify it is sufficient before synthesizing\./);
	assert.match(thin, /--- Final answer \(from worker's <final_answer> block\) ---\ndone/);
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
	assert.match(text, /Read files \(readFiles\/files_read\): src\/from-files-read\.ts/);
	assert.match(text, /Changed files \(changedFiles\/files_changed\): src\/from-changed-files\.ts/);
	assert.match(text, /Pending relay questions:\n- \[high\] Retry with smaller scope\?\n  assumption: Yes/);
	assert.match(text, /Usage: turns=2 input=1500 output=2500 cost=\$0\.5000/);
	assert.match(text, /Context: ctx=64%\/200k rem=72k/);
});

test("wait formatter makes all_terminal outcome and next action scannable", () => {
	const text = formatWaitForAgentsResult({
		reason: "all_terminal",
		workers: [
			makeWorker({ status: "completed", currentTask: { taskId: "t1", title: "Done task", goal: "Finish", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } }),
			makeWorker({ workerId: "w2", status: "idle", profileName: "reviewer" }),
		],
	});
	assert.match(text, /^Result reason: all_terminal\nAll 2 worker\(s\) reached terminal status\./);
	assert.match(text, /Next: call agent_result for each completed worker you need to synthesize\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=completed · task=Done task\n- w2 \(reviewer\) · status=idle/);
});

test("wait formatter makes relay questions copyable with agent_message and follow-up wait", () => {
	const text = formatWaitForAgentsResult({
		reason: "relay_raised",
		workers: [makeWorker({ status: "running", currentTask: { taskId: "t1", title: "Question task", goal: "Ask", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } })],
		newRelays: [{ workerId: "w1", profileName: "fixer", urgency: "high", question: "Need scope?" }],
	});
	assert.match(text, /^Result reason: relay_raised\n1 new relay question\(s\) raised — answer via agent_message, then call wait_for_agents again to resume\./);
	assert.match(text, /Pending relay questions:\n1\. w1 \(fixer\) urgency=high\n   question: Need scope\?\n   reply: agent_message \{"workerId":"w1","message":"<answer>"\}/);
	assert.match(text, /Next: answer each relay via agent_message, then call wait_for_agents \{"workerIds":\["w1"\]\} to resume\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running · task=Question task/);
});

test("wait formatter distinguishes timeout with mixed worker statuses", () => {
	const text = formatWaitForAgentsResult({
		reason: "timeout",
		workers: [makeWorker({ status: "running" }), makeWorker({ workerId: "w2", profileName: "reviewer", status: "completed" })],
	});
	assert.match(text, /^Result reason: timeout\nWait timed out; some workers may still be running\./);
	assert.match(text, /Next: inspect statuses or call wait_for_agents again with the same workerIds\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running\n- w2 \(reviewer\) · status=completed/);
});

test("wait formatter distinguishes aborted waits", () => {
	const text = formatWaitForAgentsResult({
		reason: "aborted",
		workers: [makeWorker({ status: "running" })],
	});
	assert.match(text, /^Result reason: aborted\nWait aborted by the caller before all workers reached terminal status\./);
	assert.match(text, /Next: inspect statuses with agent_status or cancel unwanted workers\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · status=running/);
});

test("wait formatter explains no_workers wrapper outcome", () => {
	const text = formatWaitForAgentsResult({ reason: "no_workers", workers: [] });
	assert.equal(text, "Result reason: no_workers\nNo tracked workers to wait on.\nNext: call delegate_task before waiting for agents.");
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

	assert.match(text, /^Worker: w1\nTask: Build seam \(t1\)\nProfile: fixer\nCWD: \/repo\nPath scope: read\/write \/repo\/src, \/repo\/tests\nStatus: running\nLifecycle: launched fresh worker\nNext: call wait_for_agents with workerIds=\["w1"\]/);
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

	assert.match(text, /Worker: w1/);
	assert.match(text, /Task: Follow-up fix \(t2\)/);
	assert.match(text, /Lifecycle: reused worker w1 for new task t2/);
	assert.match(text, /Next: call wait_for_agents with workerIds=\["w1"\]/);
});

test("small helpers preserve list contracts", () => {
	assert.equal(formatWorkers([]), "No active or persisted workers.");
	assert.equal(truncateList(["a", "b", "c"], 2), "a, b… (+1 more)");
});
