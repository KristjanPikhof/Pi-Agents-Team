import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { buildTeamWidgetLines } from "../../src/ui/status-widget";
import { stripAnsi } from "../../src/ui/theme";
import { formatCacheHitPercent, formatCacheUsage, formatCacheUsageWithHit, formatCompactTokenCount, hasCacheUsage } from "../../src/ui/usage-format";

test("formatCompactTokenCount keeps sub-1000 values raw", () => {
	assert.equal(formatCompactTokenCount(0), "0");
	assert.equal(formatCompactTokenCount(999), "999");
});

test("formatCompactTokenCount uses lowercase k at the 1000 threshold", () => {
	assert.equal(formatCompactTokenCount(1_000), "1k");
	assert.equal(formatCompactTokenCount(1_049), "1k");
	assert.equal(formatCompactTokenCount(1_050), "1.1k");
});

test("formatCompactTokenCount keeps six-digit values concise", () => {
	assert.equal(formatCompactTokenCount(123_456), "123.5k");
	assert.equal(formatCompactTokenCount(999_999), "1000k");
});

test("formatCompactTokenCount uses lowercase m at million scale", () => {
	assert.equal(formatCompactTokenCount(1_000_000), "1m");
	assert.equal(formatCompactTokenCount(1_250_000), "1.3m");
});

test("formatCacheUsage suppresses zero cache and compacts read/write tokens", () => {
	assert.equal(hasCacheUsage({ cacheReadTokens: 0, cacheWriteTokens: 0 }), false);
	assert.equal(formatCacheUsage({ cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
	assert.equal(hasCacheUsage({ cacheReadTokens: 12_345, cacheWriteTokens: 600 }), true);
	assert.equal(formatCacheUsage({ cacheReadTokens: 12_345, cacheWriteTokens: 600 }), "cache=r12.3k/w600");
});

test("formatCacheHitPercent suppresses zero-cache and zero-denominator usage", () => {
	assert.equal(formatCacheHitPercent({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
	assert.equal(formatCacheUsageWithHit({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
});

test("formatCacheUsageWithHit appends cumulative one-decimal cache hit percentage", () => {
	assert.equal(formatCacheHitPercent({ inputTokens: 20, cacheReadTokens: 980, cacheWriteTokens: 0 }), "98.0%");
	assert.equal(formatCacheUsageWithHit({ inputTokens: 20, cacheReadTokens: 980, cacheWriteTokens: 0 }), "cache=r980/w0 hit=98.0%");
	assert.equal(formatCacheUsageWithHit({ inputTokens: 1_000, cacheReadTokens: 12_345, cacheWriteTokens: 600 }), "cache=r12.3k/w600 hit=88.5%");
});

test("formatCacheUsageWithHit reports write-only cache usage as a computable zero hit rate", () => {
	assert.equal(formatCacheUsageWithHit({ inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 1_000 }), "cache=r0/w1k hit=0.0%");
});

test("fractional retained RPC cost keeps four-decimal display formatting and display.cost false behavior", () => {
	const state = createDefaultTeamState();
	state.prunedWorkerUsageTotals = {
		workers: 1,
		turns: 1,
		inputTokens: 800_001,
		outputTokens: 12_345,
		cacheReadTokens: 654_321,
		cacheWriteTokens: 9_876,
		costUsd: 0.01987654321,
		contextTokens: 812_346,
	};

	const visible = buildTeamWidgetLines(state, { displayCost: true }).map(stripAnsi).join("\n");
	assert.match(visible, /\$0\.0199/);
	assert.deepEqual(buildTeamWidgetLines(state, { displayCost: false }), []);
});
