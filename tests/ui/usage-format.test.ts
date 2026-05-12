import test from "node:test";
import assert from "node:assert/strict";
import { formatCompactTokenCount } from "../../src/ui/usage-format";

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
