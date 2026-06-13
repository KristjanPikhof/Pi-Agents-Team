import test from "node:test";
import assert from "node:assert/strict";
import { formatUnknownWorker, suggestTargets } from "../../src/util/suggest";

test("suggestTargets catches common 'all' typos", () => {
	const candidates = ["all", "w1", "w2", "w3"];
	assert.deepEqual(suggestTargets("aal", candidates, { limit: 3 })[0], "all");
	assert.deepEqual(suggestTargets("al", candidates, { limit: 3 })[0], "all");
	assert.deepEqual(suggestTargets("ALL", candidates, { limit: 3 })[0], "all");
	assert.deepEqual(suggestTargets("alll", candidates, { limit: 3 })[0], "all");
});

test("suggestTargets matches worker-id near-misses", () => {
	const candidates = ["all", "w1", "w2", "w10", "w11"];
	assert.deepEqual(suggestTargets("ww1", candidates, { limit: 2 }), ["w1", "w11"]);
	const w12Suggestions = suggestTargets("w12", candidates, { limit: 2 });
	assert.ok(w12Suggestions.length === 2);
	assert.ok(w12Suggestions.every((s) => candidates.includes(s)));
});

test("suggestTargets returns empty for totally unrelated input", () => {
	const candidates = ["all", "w1", "w2"];
	assert.deepEqual(suggestTargets("reviewer", candidates), []);
	assert.deepEqual(suggestTargets("", candidates), []);
});

test("formatUnknownWorker appends suggestions only when present", () => {
	assert.equal(formatUnknownWorker("aal", ["all"]), "Unknown worker: aal. Did you mean: all?");
	assert.equal(
		formatUnknownWorker("ww1", ["w1", "w11"]),
		"Unknown worker: ww1. Did you mean: w1, w11?",
	);
	assert.equal(formatUnknownWorker("reviewer", []), "Unknown worker: reviewer");
});
