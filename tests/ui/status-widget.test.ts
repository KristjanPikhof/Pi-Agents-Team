import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { buildTeamStatusLine, buildTeamWidgetLines } from "../../src/ui/status-widget";

test("status widget lines stay compact and include relay counts", () => {
	const state = createDefaultTeamState();
	state.relayQueue.push({
		relayId: "relay-1",
		workerId: "worker-1",
		taskId: "task-1",
		question: "Need direction?",
		assumption: "Stay passive",
		urgency: "medium",
		createdAt: Date.now(),
	});
	const line = buildTeamStatusLine(state);
	assert.match(line, /relays=1/);
	const widgetLines = buildTeamWidgetLines(state);
	assert.equal(widgetLines[0], "Pi Agent Team");
	assert.ok(widgetLines.length >= 2);
});
