import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../../src/profiles/loader";
import { applyLaunchPolicy } from "../../src/safety/launch-policy";
import type { TeamProfileSpec } from "../../src/types";

function profileWithoutThinkingLevel(): TeamProfileSpec {
	const profile = { ...resolveProfile("reviewer") };
	delete (profile as Partial<TeamProfileSpec>).thinkingLevel;
	return profile;
}

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
}
);
