import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRpcEvent } from "../../src/runtime/event-normalizer";

test("normalizeRpcEvent maps streaming and tool events", () => {
	const textEvents = normalizeRpcEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});
	assert.equal(textEvents.length, 1);
	assert.equal(textEvents[0]?.type, "worker_text_delta");

	const toolEvents = normalizeRpcEvent({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: { command: "pwd" },
	});
	assert.equal(toolEvents[0]?.type, "worker_tool_started");

	const endEvents = normalizeRpcEvent({ type: "agent_end", messages: [] });
	assert.equal(endEvents.length, 1);
	assert.equal(endEvents[0]?.type, "worker_agent_end");
	assert.deepEqual(endEvents[0] && "messages" in endEvents[0] ? endEvents[0].messages : undefined, []);

	const settledEvents = normalizeRpcEvent({ type: "agent_settled" });
	assert.equal(settledEvents.length, 1);
	assert.equal(settledEvents[0]?.type, "worker_settled");
});

test("normalizeRpcEvent preserves extension errors as distinct normalized failures", () => {
	const events = normalizeRpcEvent({ type: "extension_error", error: "optional extension failed" });
	assert.deepEqual(events.map((event) => event.type), ["worker_extension_error"]);
	assert.equal(events[0] && "error" in events[0] ? events[0].error : undefined, "optional extension failed");
});

test("normalizeRpcEvent preserves Pi summarization retry lifecycle details", () => {
	const scheduled = normalizeRpcEvent({
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2_000,
		errorMessage: "terminated",
	});
	assert.deepEqual(scheduled.map(({ timestamp: _timestamp, ...event }) => event), [{
		type: "worker_summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2_000,
		errorMessage: "terminated",
	}]);

	const compactionStart = normalizeRpcEvent({
		type: "summarization_retry_attempt_start",
		source: "compaction",
		reason: "threshold",
	});
	assert.deepEqual(compactionStart.map(({ timestamp: _timestamp, ...event }) => event), [{
		type: "worker_summarization_retry_attempt_started",
		source: "compaction",
		reason: "threshold",
	}]);

	const branchStart = normalizeRpcEvent({
		type: "summarization_retry_attempt_start",
		source: "branchSummary",
	});
	assert.deepEqual(branchStart.map(({ timestamp: _timestamp, ...event }) => event), [{
		type: "worker_summarization_retry_attempt_started",
		source: "branchSummary",
		reason: undefined,
	}]);

	const finished = normalizeRpcEvent({ type: "summarization_retry_finished" });
	assert.deepEqual(finished.map(({ timestamp: _timestamp, ...event }) => event), [{
		type: "worker_summarization_retry_finished",
	}]);
});

test("normalizeRpcEvent drops malformed summarization retry metadata", () => {
	const [scheduled] = normalizeRpcEvent({
		type: "summarization_retry_scheduled",
		attempt: "one",
		maxAttempts: Number.POSITIVE_INFINITY,
		delayMs: null,
		errorMessage: { message: "no" },
	});
	assert.ok(scheduled?.type === "worker_summarization_retry_scheduled");
	assert.equal(scheduled.attempt, undefined);
	assert.equal(scheduled.maxAttempts, undefined);
	assert.equal(scheduled.delayMs, undefined);
	assert.equal(scheduled.errorMessage, undefined);

	const [started] = normalizeRpcEvent({
		type: "summarization_retry_attempt_start",
		source: "unknown",
		reason: "threshold",
	});
	assert.ok(started?.type === "worker_summarization_retry_attempt_started");
	assert.equal(started.source, undefined);
	assert.equal(started.reason, undefined);
});

test("compaction diagnostics retain metadata without retaining summary payloads", () => {
	const [event] = normalizeRpcEvent({
		type: "compaction_end", reason: "overflow", aborted: false, willRetry: true,
		errorMessage: "Summary unavailable", result: { summary: "private compaction text" },
	});
	assert.ok(event?.type === "worker_compaction_finished");
	assert.equal(event.reason, "overflow");
	assert.equal(event.willRetry, true);
	assert.equal(event.errorMessage, "Summary unavailable");
	assert.ok(!("result" in event));
	const [malformed] = normalizeRpcEvent({ type: "compaction_start", reason: "unknown", aborted: "yes", errorMessage: {} });
	assert.ok(malformed?.type === "worker_compaction_started");
	assert.equal(malformed.reason, undefined);
	assert.equal(malformed.aborted, false);
	assert.equal(malformed.errorMessage, undefined);
});

test("provider retry diagnostics use finalError and discard malformed counters", () => {
	const [started] = normalizeRpcEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "Busy" });
	assert.ok(started?.type === "worker_retry_started");
	assert.equal(started.attempt, 1);
	assert.equal(started.maxAttempts, 3);
	assert.equal(started.delayMs, 2_000);
	assert.equal(started.errorMessage, "Busy");
	const [finished] = normalizeRpcEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Still busy" });
	assert.ok(finished?.type === "worker_retry_finished");
	assert.equal(finished.errorMessage, "Still busy");
	assert.equal(finished.success, false);
	const [malformed] = normalizeRpcEvent({ type: "auto_retry_start", attempt: "one", maxAttempts: Infinity, delayMs: null, errorMessage: {} });
	assert.ok(malformed?.type === "worker_retry_started");
	assert.equal(malformed.attempt, undefined);
	assert.equal(malformed.maxAttempts, undefined);
	assert.equal(malformed.delayMs, undefined);
	assert.equal(malformed.errorMessage, undefined);
});
