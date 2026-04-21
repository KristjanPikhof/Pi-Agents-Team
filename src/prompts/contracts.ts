import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
	if (isAbsolute(profile.promptPath)) {
		return profile.promptPath;
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
	const skills = task.skills?.map((name) => name.trim()).filter((name) => name.length > 0) ?? [];
	return [
		`## Assigned Task`,
		`Title: ${task.title}`,
		`Goal: ${task.goal}`,
		task.expectedOutput ? `Expected output: ${task.expectedOutput}` : undefined,
		task.contextHints.length > 0 ? `Context hints:\n- ${task.contextHints.join("\n- ")}` : undefined,
		task.pathScope ? `Path scope:\n- ${task.pathScope.roots.join("\n- ")}` : undefined,
		skills.length > 0
			? `Pi skills to invoke for this task:\n- ${skills.join("\n- ")}\n\nInvoke each listed skill via the Skill tool before producing your \`<final_answer>\`. If a listed skill is not installed in this Pi session, note it in the final answer and proceed without it.`
			: undefined,
		`Your final assistant message **must** wrap the complete deliverable in a single \`<final_answer>…</final_answer>\` block. Include headline, findings, files read/changed, risks, next_recommendation inside the block. Contents outside the block are treated as internal notes and are not sent to the orchestrator.`,
		`Add \`relay_question:\` + \`assumption:\` inside the block **only if you genuinely need the orchestrator to decide something**. If you do not, **omit those fields entirely** — do not write \`relay_question: none\`, \`relay_question: n/a\`, \`relay_question: -\`, or any placeholder. Placeholders are treated as real questions and waste the orchestrator's attention.`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}
