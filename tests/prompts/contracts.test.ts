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
	assert.match(withSkills, /Pi skills to use for this task/);
	assert.match(withSkills, /- writer/);
	assert.match(withSkills, /- documenting-systems/);
	// Pi dispatches skills via `/skill:<name>` commands, not a "Skill tool"
	// — the previous wording was incompatible with Pi 0.68.
	assert.match(withSkills, /\/skill:<name>/);

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
