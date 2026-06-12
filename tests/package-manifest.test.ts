import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
	files?: string[];
	pi?: { extensions?: string[]; prompts?: string[] };
};

test("package manifest exposes prompt templates without registering internal prompts", () => {
	assert.deepEqual(packageJson.pi?.prompts, ["./prompt-templates"]);
	assert.ok(!packageJson.pi?.prompts?.includes("./prompts"), "internal system prompts must not be slash templates");
	assert.ok(packageJson.files?.includes("prompt-templates/"), "prompt templates must be included in npm package files");
	assert.ok(packageJson.files?.includes("prompts/"), "internal prompts still need to ship for worker roles");
});

test("team prompt templates exist and use default positional arguments", () => {
	const files = readdirSync("prompt-templates").filter((file) => file.endsWith(".md")).sort();
	assert.deepEqual(files, ["team-fix.md", "team-map.md", "team-review.md"]);

	for (const file of files) {
		const content = readFileSync(join("prompt-templates", file), "utf8");
		assert.match(content, /^---\n[\s\S]*description:/, `${file} needs frontmatter description`);
		assert.match(content, /argument-hint:/, `${file} should advertise optional arguments`);
		assert.match(content, /\$\{1:-[^}]+\}/, `${file} should provide a default for argument 1`);
	}
});
