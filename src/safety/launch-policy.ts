import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { getWorkerPromptPath, loadWorkerPrompt } from "../prompts/contracts";
import { GENERIC_WORKER_PROMPT_SENTINEL } from "../project-config/loader";
import {
	ensureWriteScope,
	isPathScopeNarrowerOrEqual,
	isPathScopeWithinProjectRoot,
	isPathWithinProjectRoot,
	normalizePathScope,
} from "./path-scope";
import type { TeamConfig, TeamPathScope, TeamProfileSpec, ThinkingLevel, WorkerExtensionMode } from "../types";

export interface LaunchPolicyRequest {
	cwd: string;
	profile: TeamProfileSpec;
	pathScope?: TeamPathScope;
	model?: string;
	orchestratorModel?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	extensionMode?: WorkerExtensionMode;
	systemPromptPath?: string;
}

export interface LaunchPolicyResult {
	cwd: string;
	profile: TeamProfileSpec;
	pathScope?: TeamPathScope;
	model?: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	extensionMode: WorkerExtensionMode;
	systemPromptPath: string;
}

function extensionModeRank(mode: WorkerExtensionMode): number {
	switch (mode) {
		case "disable":
			return 2;
		case "worker-minimal":
			return 1;
		case "inherit":
		default:
			return 0;
	}
}

function isExtensionModeNarrowerOrEqual(candidate: WorkerExtensionMode, baseline: WorkerExtensionMode): boolean {
	return extensionModeRank(candidate) >= extensionModeRank(baseline);
}

/**
 * Tools that can mutate filesystem state via Pi's structured write path. Pi
 * DOES NOT currently enforce pathScope at the tool layer — it is an
 * orchestrator-discipline + prompt-convention boundary, NOT an OS sandbox. We
 * track `edit` and `write` here because those are the tools the orchestrator
 * contract ties to `pathScope`. `bash` can also mutate filesystem state (it
 * runs arbitrary shell commands), but requiring a writable pathScope for
 * every read-only profile that includes bash for git/ls/grep would defeat the
 * built-in roles (explorer, observer, librarian, oracle, designer, reviewer
 * all rely on bash). The honest framing: if you include bash in a profile,
 * you are trusting the model + role prompt to not mutate — use a dedicated
 * writable role like `fixer` with `write: true` + an explicit `pathScope`
 * when you actually want the worker to change files. See docs/profiles.md
 * "bash as escape hatch" for the full rationale.
 */
const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

function hasWriteTools(tools: string[]): boolean {
	return tools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool));
}

/**
 * Materialize an inline or generic-sentinel prompt to a temp file so Pi's
 * `--append-system-prompt` can read real file contents. Inline prompts (set
 * via `"prompt": "<prose>"` in agents-team.json) and the generic-worker
 * sentinel (used when a user-named role has no packaged contract) both need
 * this indirection: the sentinel is a synthetic path that is never a real file,
 * and `loadWorkerPrompt` does the `{NAME}`/`{DESCRIPTION}` substitution and
 * inline-text trimming. Without this materialization step, Pi would try to
 * read the sentinel path and crash, OR read the unrendered template with the
 * placeholders intact — both observed in review. Temp directories are left
 * for OS cleanup to reap; they are single-file prompts under a dedicated
 * prefix in `os.tmpdir()`.
 */
function materializeInlinePrompt(profileName: string, body: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-agents-team-prompt-${profileName}-`));
	const path = join(dir, "prompt.md");
	writeFileSync(path, body, { mode: 0o600 });
	return path;
}

function resolveSystemPromptPath(request: LaunchPolicyRequest, config: TeamConfig): string {
	if (request.systemPromptPath) {
		const resolvedPromptPath = resolve(request.cwd, request.systemPromptPath);
		const projectRoot = config.safety.projectRoot;
		if (projectRoot && !isPathWithinProjectRoot(resolvedPromptPath, projectRoot, request.cwd)) {
			throw new Error("Worker prompt paths must stay within the discovered project root.");
		}
		return resolvedPromptPath;
	}
	if (request.profile.promptInline || request.profile.promptPath === GENERIC_WORKER_PROMPT_SENTINEL) {
		const rendered = loadWorkerPrompt(request.profile.name, config);
		return materializeInlinePrompt(request.profile.name, rendered);
	}
	return getWorkerPromptPath(request.profile.name, config);
}

function resolvePathScope(
	request: LaunchPolicyRequest,
	config: TeamConfig,
	tools: string[],
): TeamPathScope | undefined {
	const requestedScope = request.pathScope ?? request.profile.pathScope;
	const normalizedRequestedScope = normalizePathScope(requestedScope, request.cwd);
	if (request.pathScope && !isPathScopeNarrowerOrEqual(request.pathScope, request.profile.pathScope, request.cwd)) {
		throw new Error("Launch-time path scope cannot broaden the role's configured scope.");
	}

	const projectRoot = config.safety.projectRoot;
	if (!config.safety.allowExternalPathScopes && projectRoot && !isPathScopeWithinProjectRoot(normalizedRequestedScope, projectRoot, request.cwd)) {
		throw new Error("Launch-time path scope roots must stay within the discovered project root.");
	}

	if (request.profile.writePolicy === "scoped-write" || hasWriteTools(tools)) {
		return ensureWriteScope(normalizedRequestedScope, request.cwd);
	}

	if (normalizedRequestedScope?.allowWrite) {
		throw new Error("Read-only roles cannot gain writable path scope at launch time.");
	}
	return normalizedRequestedScope;
}

export function applyLaunchPolicy(
	request: LaunchPolicyRequest,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): LaunchPolicyResult {
	const extensionMode = request.extensionMode ?? request.profile.extensionMode ?? config.safety.defaultWorkerExtensionMode;
	if (config.safety.preventRecursiveOrchestrator && extensionMode === "inherit") {
		throw new Error("Recursive orchestrator launches are blocked. Use worker-minimal or disable extensions for workers.");
	}
	if (!isExtensionModeNarrowerOrEqual(extensionMode, request.profile.extensionMode)) {
		throw new Error("Launch-time extension mode cannot broaden the role's configured extension mode.");
	}

	const tools = request.tools ?? request.profile.tools;
	if (tools.some((tool) => !request.profile.tools.includes(tool))) {
		throw new Error("Launch-time tool overrides must stay within the role's configured tool set.");
	}
	if (request.profile.writePolicy === "read-only" && hasWriteTools(tools)) {
		throw new Error("Read-only roles cannot gain edit/write tools at launch time.");
	}

	const pathScope = resolvePathScope(request, config, tools);

	return {
		cwd: resolve(request.cwd),
		profile: request.profile,
		pathScope,
		model: request.model ?? request.profile.model ?? request.orchestratorModel,
		thinkingLevel: request.thinkingLevel ?? request.profile.thinkingLevel,
		tools,
		extensionMode,
		systemPromptPath: resolveSystemPromptPath(request, config),
	};
}
