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
	assert.equal(settledEvents[0]?.type, "worker_idle");
});

test("normalizeRpcEvent preserves extension errors as distinct normalized failures", () => {
	const events = normalizeRpcEvent({ type: "extension_error", error: "optional extension failed" });
	assert.deepEqual(events.map((event) => event.type), ["worker_extension_error"]);
	assert.equal(events[0] && "error" in events[0] ? events[0].error : undefined, "optional extension failed");
});
