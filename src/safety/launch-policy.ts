import { resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../config";
import { getWorkerPromptPath } from "../prompts/contracts";
import { ensureWriteScope, normalizePathScope } from "./path-scope";
import type { TeamConfig, TeamPathScope, TeamProfileSpec, ThinkingLevel, WorkerExtensionMode } from "../types";

export interface LaunchPolicyRequest {
	cwd: string;
	profile: TeamProfileSpec;
	pathScope?: TeamPathScope;
	model?: string;
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

export function applyLaunchPolicy(
	request: LaunchPolicyRequest,
	config: TeamConfig = DEFAULT_TEAM_CONFIG,
): LaunchPolicyResult {
	const extensionMode = request.extensionMode ?? request.profile.extensionMode ?? config.safety.defaultWorkerExtensionMode;
	if (config.safety.preventRecursiveOrchestrator && extensionMode === "inherit") {
		throw new Error("Recursive orchestrator launches are blocked. Use worker-minimal or disable extensions for workers.");
	}

	const pathScope =
		request.profile.writePolicy === "scoped-write"
			? ensureWriteScope(request.pathScope ?? request.profile.pathScope, request.cwd)
			: normalizePathScope(request.pathScope ?? request.profile.pathScope, request.cwd);

	return {
		cwd: resolve(request.cwd),
		profile: request.profile,
		pathScope,
		model: request.model ?? request.profile.model,
		thinkingLevel: request.thinkingLevel ?? request.profile.thinkingLevel,
		tools: request.tools ?? request.profile.tools,
		extensionMode,
		systemPromptPath: request.systemPromptPath ?? getWorkerPromptPath(request.profile.name, config),
	};
}
