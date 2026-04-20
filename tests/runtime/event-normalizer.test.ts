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

	const idleEvents = normalizeRpcEvent({ type: "agent_end", messages: [] });
	assert.equal(idleEvents[0]?.type, "worker_idle");
});
