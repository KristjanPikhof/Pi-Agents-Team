import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveProfile } from "../../src/profiles/loader";
import { applyLaunchPolicy } from "../../src/safety/launch-policy";
import type { TeamProfileSpec } from "../../src/types";

function profileWithoutThinkingLevel(): TeamProfileSpec {
	const profile = { ...resolveProfile("reviewer") };
	delete (profile as Partial<TeamProfileSpec>).thinkingLevel;
	return profile;
}

test("worker roles reject CLI selectors that could broaden their tool set", () => {
	for (const selector of ["+write", "-read", "*", "w*", "mcp__server__*", "read,write", " +write", ""]) {
		const profile = { ...resolveProfile("reviewer"), tools: [selector] };
		assert.throws(() => applyLaunchPolicy({ cwd: process.cwd(), profile }), /Worker tools must use exact names/, selector);
	}
	const profile = { ...resolveProfile("reviewer"), tools: ["read", "mcp__server__lookup"] };
	assert.deepEqual(applyLaunchPolicy({ cwd: process.cwd(), profile }).tools, profile.tools);
});

test("applyLaunchPolicy uses explicit thinkingLevel before profile and orchestrator fallbacks", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: resolveProfile("reviewer"),
		orchestratorThinkingLevel: "low",
		thinkingLevel: "high",
	});

	assert.equal(plan.thinkingLevel, "high");
});

test("applyLaunchPolicy uses profile thinkingLevel when no explicit override is provided", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: resolveProfile("oracle"),
		orchestratorThinkingLevel: "low",
	});

	assert.equal(plan.thinkingLevel, "high");
});

test("applyLaunchPolicy uses orchestratorThinkingLevel when profile omits thinkingLevel", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: profileWithoutThinkingLevel(),
		orchestratorThinkingLevel: "low",
	});

	assert.equal(plan.thinkingLevel, "low");
});

test("applyLaunchPolicy falls back to medium when request, profile, and orchestrator omit thinkingLevel", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: profileWithoutThinkingLevel(),
	});

	assert.equal(plan.thinkingLevel, "medium");
});

test("applyLaunchPolicy passes xhigh through the thinkingLevel cascade", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: resolveProfile("reviewer"),
		thinkingLevel: "xhigh",
	});

	assert.equal(plan.thinkingLevel, "xhigh");
});

test("applyLaunchPolicy keeps model cascade independent from thinkingLevel cascade", () => {
	const plan = applyLaunchPolicy({
		cwd: process.cwd(),
		profile: profileWithoutThinkingLevel(),
		orchestratorModel: "orchestrator/fallback-model",
		orchestratorThinkingLevel: "minimal",
	});

	assert.equal(plan.model, "orchestrator/fallback-model");
	assert.equal(plan.thinkingLevel, "minimal");
});

test("applyLaunchPolicy rejects source and compiled orchestrator entries", () => {
	for (const extension of [
		resolve(process.cwd(), "extensions/index.ts"),
		resolve(process.cwd(), "dist/extensions/index.js"),
		resolve(process.cwd(), "dist/extensions/pi-agent-team/index.js"),
	]) {
		const profile = { ...resolveProfile("reviewer"), extensions: [extension] };
		assert.throws(
			() => applyLaunchPolicy({ cwd: process.cwd(), profile }),
			/Recursive orchestrator extension source/,
			extension,
		);
	}
});

test("applyLaunchPolicy allows a non-self extension alongside compiled-layout protection", () => {
	const extension = resolve(process.cwd(), "dist/extensions/custom-provider.js");
	const profile = { ...resolveProfile("reviewer"), extensions: [extension] };
	const plan = applyLaunchPolicy({ cwd: process.cwd(), profile });
	assert.deepEqual(plan.workerExtensions, [extension]);
});
