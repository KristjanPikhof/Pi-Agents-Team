import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEAM_CONFIG, buildOrchestratorSystemPrompt } from "../config";
import type { DelegatedTaskInput, PersistedTeamState, TeamConfig } from "../types";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const promptsRoot = resolve(moduleDir, "../../prompts");

function readPromptFile(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`Prompt contract not found: ${path}`);
	}
	return readFileSync(path, "utf8").trim();
}

export function getOrchestratorPromptPath(): string {
	return resolve(promptsRoot, "orchestrator.md");
}

export function getWorkerPromptPath(profileName: string, config: TeamConfig = DEFAULT_TEAM_CONFIG): string {
	const profile = config.profiles.find((item) => item.name === profileName);
	if (!profile) {
		throw new Error(`Unknown profile prompt contract: ${profileName}`);
	}
	return resolve(promptsRoot, profile.promptPath.replace(/^prompts\//, ""));
}

export function loadOrchestratorPrompt(): string {
	return readPromptFile(getOrchestratorPromptPath());
}

export function loadWorkerPrompt(profileName: string, config: TeamConfig = DEFAULT_TEAM_CONFIG): string {
	return readPromptFile(getWorkerPromptPath(profileName, config));
}

export function buildOrchestratorPromptBundle(
	state: PersistedTeamState,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): string {
	return [loadOrchestratorPrompt(), buildOrchestratorSystemPrompt(state, config)].join("\n\n");
}

export function buildWorkerTaskPrompt(task: DelegatedTaskInput): string {
	return [
		`## Assigned Task`,
		`Title: ${task.title}`,
		`Goal: ${task.goal}`,
		task.expectedOutput ? `Expected output: ${task.expectedOutput}` : undefined,
		task.contextHints.length > 0 ? `Context hints:\n- ${task.contextHints.join("\n- ")}` : undefined,
		task.pathScope ? `Path scope:\n- ${task.pathScope.roots.join("\n- ")}` : undefined,
		`Your final assistant message **must** wrap the complete deliverable in a single \`<final_answer>…</final_answer>\` block. Include headline, findings, files read/changed, risks, next_recommendation, and (if needed) relay_question + assumption — all inside the block. Contents outside the block are treated as internal notes and are not sent to the orchestrator.`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}
