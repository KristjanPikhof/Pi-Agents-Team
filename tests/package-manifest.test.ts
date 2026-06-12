import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
	files?: string[];
	pi?: { extensions?: string[]; prompts?: string[] };
};

test("package manifest registers the extension without exposing prompt templates", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./extensions/index.ts"]);
	assert.equal(packageJson.pi?.prompts, undefined, "package must not expose user prompt templates");
	assert.ok(!packageJson.files?.includes("prompt-templates/"), "prompt templates must not be included in npm package files");
	assert.ok(packageJson.files?.includes("prompts/"), "internal prompts still need to ship for worker roles");
});
