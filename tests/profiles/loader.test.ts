import test from "node:test";
import assert from "node:assert/strict";
import { loadProfiles, resolveProfile } from "../../src/profiles/loader";

test("loadProfiles reads packaged profile markdown files", () => {
	const profiles = loadProfiles();
	assert.ok(profiles.length >= 6);
	assert.equal(resolveProfile("fixer").writePolicy, "scoped-write");
	assert.equal(resolveProfile("explorer").extensionMode, "worker-minimal");
});
