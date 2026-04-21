import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerMessageDelivery } from "../../src/comms/agent-messaging";

test("resolveWorkerMessageDelivery routes by worker status so idle workers get a fresh prompt", () => {
	assert.equal(resolveWorkerMessageDelivery("running", "auto"), "steer");
	assert.equal(resolveWorkerMessageDelivery("running", "steer"), "steer");
	assert.equal(resolveWorkerMessageDelivery("running", "follow_up"), "follow_up");

	assert.equal(resolveWorkerMessageDelivery("idle", "auto"), "prompt");
	assert.equal(resolveWorkerMessageDelivery("idle", "steer"), "prompt");
	assert.equal(resolveWorkerMessageDelivery("idle", "follow_up"), "prompt");
	assert.equal(resolveWorkerMessageDelivery("waiting_followup", "auto"), "prompt");
});
