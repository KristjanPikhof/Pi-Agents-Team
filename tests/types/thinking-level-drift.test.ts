import test from "node:test";
import assert from "node:assert/strict";
import type { ThinkingLevel as UpstreamThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "../../src/types";

type Exact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
		? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
			? true
			: false
		: false;

const thinkingLevelDriftCheck: Exact<ThinkingLevel, UpstreamThinkingLevel> = true;

test("local ThinkingLevel stays in lockstep with Pi upstream", () => {
	assert.equal(thinkingLevelDriftCheck, true);
});
