import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_CONFIG, createDefaultTeamState } from "../../src/config";
import {
	buildOrchestratorPromptBundle,
	buildWorkerTaskPrompt,
	getOrchestratorPromptPath,
	getWorkerPromptPath,
	loadOrchestratorPrompt,
	loadWorkerPrompt,
} from "../../src/prompts/contracts";

test("prompt contract loader resolves orchestrator and worker prompts", () => {
	assert.match(getOrchestratorPromptPath(), /prompts\/orchestrator\.md$/);
	assert.match(getWorkerPromptPath("fixer"), /prompts\/agents\/fixer\.md$/);
	assert.match(loadOrchestratorPrompt(), /orchestrator/i);
	assert.match(loadWorkerPrompt("reviewer"), /reviewer/i);
});

test("buildOrchestratorPromptBundle combines file contract with runtime state", () => {
	const state = createDefaultTeamState();
	const bundle = buildOrchestratorPromptBundle(state);
	assert.match(bundle, /Pi Agents Team Orchestrator Contract/);
	assert.match(bundle, /Active worker count/);
	assert.match(bundle, /below 50% context/);
	assert.match(bundle, /at or above 80% context/);
	assert.match(bundle, /32768 remaining tokens/);
	assert.doesNotMatch(bundle, /auto-compact option|auto compact option/i);
});

test("built-in profile catalog keeps mode labels without duplicate access wording", () => {
	const state = createDefaultTeamState();
	const bundle = buildOrchestratorPromptBundle(state);

	assert.match(
		bundle,
		/- `explorer` \(read-only\) — Use for fast codebase reconnaissance\. Best for 'where is X\?', 'how does Y work\?', 'list all files that touch Z', or 'map the structure of this directory' questions\./,
	);
	assert.match(
		bundle,
		/- `fixer` \(write\) — Use for bounded code changes: implement a specific fix, add a test, refactor a single file, apply a targeted edit\. Requires an explicit pathScope at delegate time\./,
	);
	assert.doesNotMatch(bundle, /\(read-only\).*Read-only\./);
	assert.doesNotMatch(bundle, /\(write\).*Write-capable — do not use for questions or analysis\./);
});

test("buildWorkerTaskPrompt includes relay guidance and scope", () => {
	const prompt = buildWorkerTaskPrompt({
		taskId: "task-1",
		title: "Inspect comms",
		goal: "Review ping flow",
		requestedBy: "orchestrator",
		profileName: "reviewer",
		cwd: process.cwd(),
		contextHints: ["Focus on passive ping"],
		pathScope: { roots: ["src/comms"], allowReadOutsideRoots: false, allowWrite: false },
		createdAt: Date.now(),
	});
	assert.match(prompt, /relay_question/i);
	assert.match(prompt, /<final_answer>/);
	for (const label of ["headline", "read_files", "changed_files", "risks", "next_recommendation"]) {
		assert.ok(prompt.includes(`\`${label}:\``), `expected task prompt to require ${label}:`);
	}
	assert.match(prompt, /src\/comms/);
	assert.doesNotMatch(prompt, /Pi skills to use/);
});

test("buildWorkerTaskPrompt injects skills section only when skills are provided", () => {
	const base = {
		taskId: "task-2",
		title: "Draft doc",
		goal: "Write it clearly",
		requestedBy: "orchestrator" as const,
		profileName: "librarian",
		cwd: process.cwd(),
		contextHints: [],
		createdAt: Date.now(),
	};

	const withSkills = buildWorkerTaskPrompt({ ...base, skills: ["writer", "documenting-systems"] });
	assert.match(withSkills, /Requested Pi skills for this task/);
	assert.match(withSkills, /- writer/);
	assert.match(withSkills, /- documenting-systems/);
	assert.match(withSkills, /Load and apply each relevant requested skill by name/);
	assert.doesNotMatch(withSkills, /\/skill:/);
	assert.doesNotMatch(withSkills, /Skill tool/i);

	const withoutSkills = buildWorkerTaskPrompt(base);
	assert.doesNotMatch(withoutSkills, /Pi skills to use/);

	const emptySkills = buildWorkerTaskPrompt({ ...base, skills: ["  ", ""] });
	assert.doesNotMatch(emptySkills, /Pi skills to use/);
});

test("worker prompt lookup honors resolved absolute project prompt paths", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-prompts-"));
	const promptPath = join(root, "reviewer.md");
	writeFileSync(promptPath, "# reviewer project override\n");
	const config = {
		...DEFAULT_TEAM_CONFIG,
		profiles: DEFAULT_TEAM_CONFIG.profiles.map((profile) =>
			profile.name === "reviewer" ? { ...profile, promptPath } : profile),
	};

	assert.equal(getWorkerPromptPath("reviewer", config), promptPath);
	assert.match(loadWorkerPrompt("reviewer", config), /project override/i);
});
