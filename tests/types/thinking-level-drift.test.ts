import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { THINKING_LEVELS } from "../../src/types";

const PI_0806_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const upstreamTypesCandidates = [
	"node_modules/@earendil-works/pi-agent-core/dist/types.d.ts",
	"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts",
];

test("local ThinkingLevel matches the Pi 0.80.6 contract", () => {
	assert.deepEqual(THINKING_LEVELS, PI_0806_THINKING_LEVELS);
});

test("upstream ThinkingLevel stays locked to the Pi 0.80.6 contract", () => {
	const typesPath = upstreamTypesCandidates.find(existsSync);
	assert.ok(typesPath, "installed Pi agent-core type declarations must be present");
	const declaration = readFileSync(typesPath, "utf8");
	const match = declaration.match(/export type ThinkingLevel = ([^;]+);/);
	assert.ok(match, "upstream ThinkingLevel declaration must be exported");
	assert.deepEqual(
		[...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
		PI_0806_THINKING_LEVELS,
	);
});
