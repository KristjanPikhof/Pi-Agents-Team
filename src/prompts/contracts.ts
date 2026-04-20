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
		`Report back with a compact worker result containing findings, files read or changed, risks, next recommendation, and an optional relay question plus assumption if you need orchestrator guidance.`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}
