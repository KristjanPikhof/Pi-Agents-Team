import { resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { getWorkerPromptPath } from "../prompts/contracts";
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

function hasWriteTools(tools: string[]): boolean {
	return tools.includes("edit") || tools.includes("write");
}

function resolveSystemPromptPath(request: LaunchPolicyRequest, config: TeamConfig): string {
	if (!request.systemPromptPath) {
		return getWorkerPromptPath(request.profile.name, config);
	}
	const resolvedPromptPath = resolve(request.cwd, request.systemPromptPath);
	const projectRoot = config.safety.projectRoot;
	if (projectRoot && !isPathWithinProjectRoot(resolvedPromptPath, projectRoot, request.cwd)) {
		throw new Error("Worker prompt paths must stay within the discovered project root.");
	}
	return resolvedPromptPath;
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
	if (projectRoot && !isPathScopeWithinProjectRoot(normalizedRequestedScope, projectRoot, request.cwd)) {
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
