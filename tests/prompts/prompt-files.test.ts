import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("worker prompt files enforce subordinate reporting", () => {
	const promptDir = resolve(process.cwd(), "prompts/agents");
	const files = readdirSync(promptDir).filter((file) => file.endsWith(".md"));
	assert.ok(files.length >= 6);

	for (const file of files) {
		const content = readFileSync(resolve(promptDir, file), "utf8");
		assert.match(content, /do not address the user directly/i, `${file} should keep the worker subordinate`);
		assert.match(content, /relay_question/i, `${file} should mention relay escalation`);
	}
});
