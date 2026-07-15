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

type Pi0806ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const localThinkingLevelDriftCheck: Exact<ThinkingLevel, Pi0806ThinkingLevel> = true;
const upstreamThinkingLevelDriftCheck: Exact<UpstreamThinkingLevel, Pi0806ThinkingLevel> = true;

test("local and upstream ThinkingLevel stay locked to the Pi 0.80.6 contract", () => {
	assert.equal(localThinkingLevelDriftCheck, true);
	assert.equal(upstreamThinkingLevelDriftCheck, true);
});
