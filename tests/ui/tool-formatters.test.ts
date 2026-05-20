import test from "node:test";
import assert from "node:assert/strict";
import {
	FINAL_ANSWER_METADATA_LABELS,
	TOOL_SECTION_LABELS,
	TOOL_SECTION_ORDER,
	WORKER_STATUS_SCAN_ORDER,
	formatAgentMessageResult,
	formatDelegateTaskResult,
	formatWaitForAgentsResult,
	formatWorkerCompact,
	formatWorkerDetail,
	formatWorkers,
	formatScanSection,
	truncateList,
	truncateScanValue,
	visibleWidth,
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
	assert.equal(TOOL_SECTION_LABELS.readFiles, "Read files");
	assert.equal(TOOL_SECTION_LABELS.changedFiles, "Changed files");
	assert.equal(TOOL_SECTION_LABELS.finalAnswer, "Result");
	assert.deepEqual(TOOL_SECTION_ORDER, [
		"Lifecycle",
		"Status",
		"Pending relay questions",
		"Headline",
		"Read files",
		"Changed files",
		"Risks",
		"Next",
		"Result note",
		"Result",
	]);
	assert.deepEqual(WORKER_STATUS_SCAN_ORDER, ["error", "aborted", "exited", "waiting_followup", "running", "starting", "created", "completed", "idle"]);
	assert.equal(FINAL_ANSWER_METADATA_LABELS.headline, "Headline");
	assert.equal(FINAL_ANSWER_METADATA_LABELS.result, "Result");
});

// Pins scan-friendly helper contracts without snapshotting whole tool outputs.
test("scan sections normalize ANSI and truncate by visible width", () => {
	assert.equal(visibleWidth("\u001b[31mabcdef\u001b[0m"), 6);
	assert.equal(truncateScanValue("  \u001b[31mok\u001b[0m  ", { maxWidth: 10 }), "ok");
	assert.equal(truncateScanValue("  \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007  ", { maxWidth: 10 }), "link");
	assert.equal(truncateScanValue("  \u001b]0;window title\u001b\\ok  ", { maxWidth: 10 }), "ok");
	assert.equal(truncateScanValue("  \u001b[31mabcdef\u001b[0m  ", { maxWidth: 4 }), "abc…");
	assert.equal(formatScanSection({ label: "Risks", items: ["none", "  multi\nline  risk  "], maxWidth: 20 }), "Risks:\n- none\n- multi line risk");
	assert.equal(formatScanSection({ label: "Next", value: "reviewer should spot-check helper consumers", maxWidth: 18 }), "Next: reviewer should s…");
	assert.equal(formatScanSection({ label: "Result note", value: "", empty: "No final answer block extracted yet." }), "Result note: No final answer block extracted yet.");
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
	assert.doesNotMatch(text, /\x1b\[/, "tool result text must be ANSI-free");
	assert.match(text, /^fixer \(w1\)/);
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

test("formatWorkerCompact summarizes long file and risk lists without truncating final_answer", () => {
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
	assert.match(text, /Headline: Many files/);
	assert.match(text, /Read files:\n- read-0\.ts\n- read-1\.ts\n- read-2\.ts\n- read-3\.ts\n- read-4\.ts\n- \+7 more/);
	assert.match(text, /Risks:\n- r1\n- r2\n- r3\n- r4\n- r5\n- \+1 more/);
	assert.match(text, /Result:\nline 1\nline 2/);
});

test("formatWorkerCompact tolerates partial persisted summaries", () => {
	const worker = makeWorker({
		lastSummary: {
			workerId: "w1",
			taskId: "t1",
			headline: "Legacy summary",
			status: "idle",
			relayQuestionCount: 0,
			updatedAt: 6,
		} as WorkerRuntimeState["lastSummary"],
		finalAnswer: "complete",
	});
	const text = formatWorkerCompact(worker);
	assert.match(text, /Headline: Legacy summary/);
	assert.doesNotMatch(text, /Read files/);
	assert.match(text, /Result:\ncomplete/);
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
	assert.doesNotMatch(text, /\x1b\[/, "agent_result text must be ANSI-free");
	assert.match(text, /^fixer \(w1\)/);
	const plain = stripAnsi(text);
	for (const part of [
		"fixer (w1)",
		"Task: Render result",
		"Status: completed (Completed)",
		"Headline: Renderer improved",
		"Read files:\n- src/ui/tool-formatters.ts",
		"Changed files:\n- tests/ui/tool-formatters.test.ts",
		"Risks:\n- none",
		"Next: reviewer to spot-check output",
		"Result:\nheadline: renderer improved\nverification: npm test passed",
	]) assert.match(plain, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(plain, /^Worker:/m);
	assert.doesNotMatch(plain, /^Usage:/m);
	assert.doesNotMatch(plain, /Latest assistant text/);
});

test("formatWorkerCompact shows concise no-final and thin-final output", () => {
	const noFinal = formatWorkerCompact(makeWorker());
	assert.match(noFinal, /Result:\nNo final answer block extracted yet/);

	const thin = formatWorkerCompact(makeWorker({ finalAnswer: "done" }));
	assert.match(thin, /Result note: final answer is very short; verify it is complete\./);
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
	assert.match(text, /Status: error \(Error\)/);
	assert.match(text, /Error: worker crashed/);
	assert.ok(text.indexOf("Pending relay questions:") < text.indexOf("Headline: Summary alias accepted"));
	assert.match(text, /Headline: Summary alias accepted/);
	assert.match(text, /Read files:\n- src\/from-files-read\.ts/);
	assert.match(text, /Changed files:\n- src\/from-changed-files\.ts/);
	assert.match(text, /Risks:\n- crash prevented completion/);
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
	assert.match(text, /^Wait: all agents finished/);
	assert.match(text, /Status: 2 agent\(s\) finished or stopped/);
	assert.match(text, /Next: read results for w1, w2\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · Completed · Done task\n- w2 \(reviewer\) · Idle/);
	assert.doesNotMatch(text, /all_terminal|agent_result|status=|task=/);
});

test("wait formatter makes relay questions copyable with follow-up wait", () => {
	const text = formatWaitForAgentsResult({
		reason: "relay_raised",
		workers: [makeWorker({ status: "running", currentTask: { taskId: "t1", title: "Question task", goal: "Ask", requestedBy: "orchestrator", profileName: "fixer", cwd: "/repo", contextHints: [], createdAt: 1 } })],
		newRelays: [{ workerId: "w1", profileName: "fixer", urgency: "high", question: "Need scope?" }],
	});
	assert.match(text, /^Wait: relay question raised/);
	assert.match(text, /Status: 1 relay question\(s\) need reply/);
	assert.match(text, /Pending relay questions:\n1\. fixer \(w1\) \[high\]\n   question: Need scope\?\n   reply: send answer to w1/);
	assert.match(text, /Next: answer relay\(s\), then wait for w1\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · Running · Question task/);
	assert.doesNotMatch(text, /relay_raised|agent_message|wait_for_agents|status=|task=/);
});

test("wait formatter distinguishes timeout with mixed worker statuses", () => {
	const text = formatWaitForAgentsResult({
		reason: "timeout",
		workers: [makeWorker({ status: "running" }), makeWorker({ workerId: "w2", profileName: "reviewer", status: "completed" })],
	});
	assert.match(text, /^Wait: timeout/);
	assert.match(text, /Status: still waiting for active agent\(s\)/);
	assert.match(text, /Next: wait again for w1, w2 or inspect status\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · Running\n- w2 \(reviewer\) · Completed/);
	assert.doesNotMatch(text, /wait_for_agents|agent_status|status=/);
});

test("wait formatter distinguishes aborted waits", () => {
	const text = formatWaitForAgentsResult({
		reason: "aborted",
		workers: [makeWorker({ status: "running" })],
	});
	assert.match(text, /^Wait: aborted/);
	assert.match(text, /Status: wait cancelled before all agents finished/);
	assert.match(text, /Next: inspect status or cancel unwanted agents\./);
	assert.match(text, /Workers:\n- w1 \(fixer\) · Running/);
});

test("wait formatter explains no_workers wrapper outcome", () => {
	const text = formatWaitForAgentsResult({ reason: "no_workers", workers: [] });
	assert.equal(text, "Wait: no agents\nStatus: no agents tracked\nNext: delegate a task first.");
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

	assert.doesNotMatch(text, /\x1b\[/, "delegate_task text must be ANSI-free");
	const plain = stripAnsi(text);
	assert.equal(plain, "w1 · Build seam (t1)");
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
	assert.equal(plain, "w1 · Follow-up fix (t2)");
	assert.doesNotMatch(plain, /Profile:/);
	assert.doesNotMatch(plain, /Status:/);
	assert.doesNotMatch(plain, /CWD:/);
	assert.doesNotMatch(plain, /Path scope:/);
	assert.doesNotMatch(plain, /Next:/);
});

// Direct formatter coverage for warning text that callers may pass when delegate_task is gated or rejected.
test("delegate formatter can surface routing and validation warnings when available", () => {
	const worker = makeWorker({ status: "created", profileName: "reviewer" });
	const text = formatDelegateTaskResult({
		worker,
		warnings: ["Team routing off. Run /team-enable on to delegate.", "Invalid request: pathScopeRoots is required for scoped-write profiles."],
	});

	const plain = stripAnsi(text);
	assert.match(plain, /^w1 · delegated task/);
	assert.doesNotMatch(plain, /Status:/);
	assert.match(plain, /Warning:\n- Team routing off\. Run \/team-enable on to delegate\.\n- Invalid request: pathScopeRoots is required for scoped-write profiles\./);
	assert.doesNotMatch(plain, /Next:/);
});

test("agent message formatter names resolved delivery and wake/resume cases", () => {
	const worker = makeWorker({ status: "running" });
	assert.equal(formatAgentMessageResult({ worker, delivery: "steer", previousStatus: "running" }), "Steering running agent fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "follow_up", previousStatus: "running" }), "Queued follow-up for fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "prompt", previousStatus: "idle" }), "Waking idle agent fixer (w1).");
	assert.equal(formatAgentMessageResult({ worker, delivery: "prompt", previousStatus: "waiting_followup" }), "Resuming agent fixer (w1).");
});

test("worker list items expose context budget when available", () => {
	const text = formatWorkers([
		makeWorker({
			usage: { turns: 2, inputTokens: 1500, outputTokens: 2500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, contextTokens: 128000, contextWindow: 200000, contextPercent: 64, contextRemainingTokens: 72000 },
		}),
	]);
	assert.equal(text, "- w1 (fixer) · Idle · ctx=64%/200k rem=72k");
});

test("small helpers preserve list contracts", () => {
	assert.equal(formatWorkers([]), "No active or persisted workers.");
	assert.equal(truncateList(["a", "b", "c"], 2), "a, b… (+1 more)");
});
