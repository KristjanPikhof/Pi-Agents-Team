import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
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
	assert.match(bundle, /Pi Agent Team Orchestrator Contract/);
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
});
