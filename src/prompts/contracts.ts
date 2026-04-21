import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEAM_CONFIG, buildOrchestratorSystemPrompt } from "../config";
import { GENERIC_WORKER_PROMPT_SENTINEL } from "../project-config/loader";
import type { DelegatedTaskInput, PersistedTeamState, TeamConfig, TeamProfileSpec } from "../types";

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

function getGenericWorkerPromptPath(): string {
	return resolve(promptsRoot, "agents/_generic-worker.md");
}

export function getWorkerPromptPath(profileName: string, config: TeamConfig = DEFAULT_TEAM_CONFIG): string {
	const profile = config.profiles.find((item) => item.name === profileName);
	if (!profile) {
		throw new Error(`Unknown profile prompt contract: ${profileName}`);
	}
	if (profile.promptPath === GENERIC_WORKER_PROMPT_SENTINEL) {
		return getGenericWorkerPromptPath();
	}
	if (isAbsolute(profile.promptPath)) {
		return profile.promptPath;
	}
	return resolve(promptsRoot, profile.promptPath.replace(/^prompts\//, ""));
}

export function loadOrchestratorPrompt(): string {
	return readPromptFile(getOrchestratorPromptPath());
}

/**
 * Resolve the worker prompt for a given profile, handling:
 *  - inline prompt text (from `"prompt": "<prose>"` that didn't resolve to a file)
 *  - the generic-worker sentinel (from `"prompt": "default"` on a custom-named role)
 *  - a packaged or project-provided markdown file
 *
 * For generic-worker resolution, the role's name + description are substituted
 * into `{NAME}` / `{DESCRIPTION}` placeholders in the template.
 */
export function loadWorkerPrompt(profileName: string, config: TeamConfig = DEFAULT_TEAM_CONFIG): string {
	const profile = config.profiles.find((item) => item.name === profileName);
	if (!profile) {
		throw new Error(`Unknown profile prompt contract: ${profileName}`);
	}
	if (profile.promptInline) {
		return profile.promptInline.trim();
	}
	if (profile.promptPath === GENERIC_WORKER_PROMPT_SENTINEL) {
		return renderGenericWorkerPrompt(profile);
	}
	return readPromptFile(getWorkerPromptPath(profileName, config));
}

function renderGenericWorkerPrompt(profile: TeamProfileSpec): string {
	const template = readPromptFile(getGenericWorkerPromptPath());
	const description = (profile.description ?? "").trim() || "(no description provided)";
	return template.replace(/\{NAME\}/g, profile.name).replace(/\{DESCRIPTION\}/g, description);
}

function buildAvailableProfilesBlock(config: TeamConfig): string {
	if (config.profiles.length === 0) {
		return "## Available worker profiles\n\n(No profiles are configured — `delegate_task` will fail until roles are declared in agents-team.json.)";
	}
	const lines = config.profiles.map((profile) => {
		const description = (profile.description ?? "").trim() || "(no description)";
		const writeLabel = profile.writePolicy === "scoped-write" ? "write" : "read-only";
		return `- \`${profile.name}\` (${writeLabel}) — ${description}`;
	});
	return [
		"## Available worker profiles",
		"",
		"Pass one of these names as `delegate_task.profileName`. Profile names are declared by the user in agents-team.json (or fall back to built-ins when no config is present), so this list is whatever the operator decided — do NOT invent names that are not in this list.",
		"",
		...lines,
	].join("\n");
}

export function buildOrchestratorPromptBundle(
	state: PersistedTeamState,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): string {
	return [
		loadOrchestratorPrompt(),
		buildAvailableProfilesBlock(config),
		buildOrchestratorSystemPrompt(state, config),
	].join("\n\n");
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
			? `Pi skills to use for this task:\n- ${skills.join("\n- ")}\n\nPi has loaded these skills into your system prompt context. Invoke each relevant skill via \`/skill:<name>\` (or let the matching skill activate automatically by following the flow described in your system prompt) before producing your \`<final_answer>\`. If a listed skill is not available in this Pi session, note it in the final answer and proceed without it.`
			: undefined,
		`Your final assistant message **must** wrap the complete deliverable in a single \`<final_answer>…</final_answer>\` block. Include headline, findings, files read/changed, risks, next_recommendation inside the block. Contents outside the block are treated as internal notes and are not sent to the orchestrator.`,
		`Add \`relay_question:\` + \`assumption:\` inside the block **only if you genuinely need the orchestrator to decide something**. If you do not, **omit those fields entirely** — do not write \`relay_question: none\`, \`relay_question: n/a\`, \`relay_question: -\`, or any placeholder. Placeholders are treated as real questions and waste the orchestrator's attention.`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}
