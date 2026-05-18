import test from "node:test";
import assert from "node:assert/strict";
import { renderAgentToolCallTitle } from "../../src/ui/tool-renderers";

const plainTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

test("renderAgentToolCallTitle renders friendly call titles", () => {
	const delegate = renderAgentToolCallTitle("delegate_task")({ profileName: "reviewer" }, plainTheme) as { text: string };
	assert.equal(delegate.text, "Delegating to reviewer");

	const wait = renderAgentToolCallTitle("wait_for_agents")({ workerIds: ["w1", "w2"] }, plainTheme) as { text: string };
	assert.equal(wait.text, "Waiting for agents (w1, w2)");

	const result = renderAgentToolCallTitle("agent_result")({ workerId: "w3" }, plainTheme) as { text: string };
	assert.equal(result.text, "Reading agent result (w3)");
});

test("renderAgentToolCallTitle reuses the previous Text component", () => {
	const renderCall = renderAgentToolCallTitle("agent_status");
	const first = renderCall({ workerId: "w1" }, plainTheme) as { text: string };
	const second = renderCall({}, plainTheme, { lastComponent: first }) as { text: string };
	assert.equal(second, first);
	assert.equal(second.text, "Checking agent status");
});
