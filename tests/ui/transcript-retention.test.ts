import test from "node:test";
import assert from "node:assert/strict";
import { DISPLAY_TRANSCRIPT_LINE_CAP, formatRetainedTranscript } from "../../src/ui/transcript-retention";

test("formatRetainedTranscript restores a truncation note when line retention trims an existing note away", () => {
	const alreadyNoted = [
		"[transcript truncated: showing retained tail; omitted earlier WorkerManager text]",
		...Array.from({ length: DISPLAY_TRANSCRIPT_LINE_CAP + 5 }, (_, index) => `worker retained line ${index}`),
	].join("\n");

	const retained = formatRetainedTranscript(alreadyNoted);

	assert.match(retained, /^\[transcript truncated: showing retained tail; omitted /);
	assert.match(retained, /worker retained line 4004$/);
	assert.doesNotMatch(retained, /earlier WorkerManager text/);
});

test("formatRetainedTranscript does not duplicate an existing truncation note that remains retained", () => {
	const alreadyNoted = "[transcript truncated: showing retained tail; omitted earlier WorkerManager text]\nlatest assistant line";

	const retained = formatRetainedTranscript(alreadyNoted);

	assert.equal((retained.match(/\[transcript truncated:/g) ?? []).length, 1);
	assert.match(retained, /earlier WorkerManager text/);
});
