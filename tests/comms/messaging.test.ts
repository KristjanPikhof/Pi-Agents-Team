import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerMessageDelivery } from "../../src/comms/agent-messaging";

test("resolveWorkerMessageDelivery uses steer for running workers and follow_up for idle ones", () => {
	assert.equal(resolveWorkerMessageDelivery("running", "auto"), "steer");
	assert.equal(resolveWorkerMessageDelivery("idle", "auto"), "follow_up");
	assert.equal(resolveWorkerMessageDelivery("running", "follow_up"), "follow_up");
});
