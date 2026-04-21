import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { CURRENT_DEFAULTS_VERSION, DEFAULT_TEAM_CONFIG, TeamProjectConfigSchema } from "../config";
import {
	DEFAULT_MODEL_SENTINEL,
	DEFAULT_PROMPT_SENTINEL,
	PROJECT_CONFIG_DIAGNOSTIC_SEVERITIES,
	PROJECT_CONFIG_STATUSES,
	TEAM_PROJECT_CONFIG_DIR,
	TEAM_PROJECT_CONFIG_FILE,
	TEAM_PROJECT_CONFIG_RELATIVE_PATH,
	type LoadedTeamProjectConfig,
	type PartialRawProjectRoleConfigMap,
	type ProjectConfigDiagnostic,
	type ProjectRoleConfig,
	type ProjectRoleFlatConfig,
	type ProjectRolePromptConfig,
	type RawProjectRoleConfig,
	type TeamConfig,
	type TeamConfigScope,
	type TeamEnabledSource,
	type TeamPathScope,
	type TeamProfileSpec,
	type TeamProjectConfigFile,
	type TeamProjectConfigLayer,
	type WorkerWritePolicy,
} from "../types";

function clonePathScope(pathScope: TeamPathScope | undefined): TeamPathScope | undefined {
	if (!pathScope) return undefined;
	return {
		roots: [...pathScope.roots],
		allowReadOutsideRoots: pathScope.allowReadOutsideRoots,
		allowWrite: pathScope.allowWrite,
	};
}

function cloneProfile(profile: TeamProfileSpec): TeamProfileSpec {
	return {
		...profile,
		tools: [...profile.tools],
		pathScope: clonePathScope(profile.pathScope),
	};
}

function cloneTeamConfig(config: TeamConfig): TeamConfig {
	return {
		...config,
		orchestration: {
			...config.orchestration,
			systemPromptNotes: [...config.orchestration.systemPromptNotes],
		},
		rpc: {
			...config.rpc,
			args: [...config.rpc.args],
		},
		summaries: { ...config.summaries },
		ui: { ...config.ui },
		safety: { ...config.safety },
		persistence: { ...config.persistence },
		profiles: config.profiles.map(cloneProfile),
	};
}

function makeDiagnostic(
	severity: ProjectConfigDiagnostic["severity"],
	code: string,
	message: string,
	fieldPath?: string,
): ProjectConfigDiagnostic {
	return { severity, code, message, fieldPath };
}

function extensionModeRank(mode: TeamProfileSpec["extensionMode"]): number {
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

function isExtensionModeNarrowerOrEqual(candidate: TeamProfileSpec["extensionMode"], baseline: TeamProfileSpec["extensionMode"]): boolean {
	return extensionModeRank(candidate) >= extensionModeRank(baseline);
}

function isPathScopeNarrowerOrEqual(candidate: TeamPathScope | undefined, baseline: TeamPathScope | undefined): boolean {
	if (!candidate) return baseline === undefined;
	if (!baseline) return true;
	if (candidate.allowWrite && !baseline.allowWrite) return false;
	if (candidate.allowReadOutsideRoots && !baseline.allowReadOutsideRoots) return false;
	return candidate.roots.every((candidateRoot) => baseline.roots.some((baselineRoot) => isPathInsideRoot(candidateRoot, baselineRoot)));
}

function isPathInsideRoot(targetPath: string, root: string): boolean {
	const rel = relative(root, targetPath);
	return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

interface ResolvedPath {
	path?: string;
	diagnostic?: ProjectConfigDiagnostic;
}

function resolveLayerPath(layerRoot: string, value: string, fieldPath: string, options: { requireInsideLayerRoot: boolean }): ResolvedPath {
	const resolved = isAbsolute(value) ? value : resolve(layerRoot, value);
	if (options.requireInsideLayerRoot && !isPathInsideRoot(resolved, layerRoot)) {
		return {
			diagnostic: makeDiagnostic("error", "project_path_escape", `Resolved path must stay within the project root: ${value}`, fieldPath),
		};
	}
	return { path: resolved };
}

function normalizePathScope(
	pathScope: TeamPathScope | undefined,
	layerRoot: string,
	fieldPath: string,
	options: { requireInsideLayerRoot: boolean },
) {
	if (!pathScope) return { pathScope: undefined as TeamPathScope | undefined, diagnostics: [] as ProjectConfigDiagnostic[] };
	if (pathScope.allowWrite && !pathScope.roots.length) {
		return {
			pathScope: undefined,
			diagnostics: [makeDiagnostic("error", "path_scope_roots_required", "Writable path scopes require at least one root.", fieldPath)],
		};
	}

	const diagnostics: ProjectConfigDiagnostic[] = [];
	const roots: string[] = [];
	for (const [index, root] of pathScope.roots.entries()) {
		const resolved = resolveLayerPath(layerRoot, root, `${fieldPath}.roots[${index}]`, options);
		if (resolved.diagnostic) {
			diagnostics.push(resolved.diagnostic);
			continue;
		}
		roots.push(resolved.path!);
	}

	if (diagnostics.length > 0) {
		return { pathScope: undefined, diagnostics };
	}

	return {
		pathScope: {
			roots,
			allowReadOutsideRoots: pathScope.allowReadOutsideRoots,
			allowWrite: pathScope.allowWrite,
		},
		diagnostics,
	};
}

function normalizePromptPath(
	profile: TeamProfileSpec,
	roleConfig: ProjectRoleConfig,
	layerRoot: string,
	fieldPath: string,
	options: { requireInsideLayerRoot: boolean; layerScope: TeamConfigScope; layerPath: string },
) {
	const prompt = roleConfig.prompt;
	if (prompt.source === "builtin") {
		if (prompt.path) {
			return {
				promptPath: profile.promptPath,
				diagnostics: [makeDiagnostic("error", "builtin_prompt_path_forbidden", "prompt.path must be omitted when prompt.source is builtin.", fieldPath)],
			};
		}
		return { promptPath: profile.promptPath, diagnostics: [] as ProjectConfigDiagnostic[] };
	}

	if (!prompt.path) {
		return {
			promptPath: profile.promptPath,
			diagnostics: [makeDiagnostic("error", "project_prompt_path_required", "prompt.path is required when prompt.source is project.", fieldPath)],
		};
	}

	const resolved = resolveLayerPath(layerRoot, prompt.path, `${fieldPath}.path`, options);
	if (resolved.diagnostic) {
		return { promptPath: profile.promptPath, diagnostics: [resolved.diagnostic] };
	}
	if (!existsSync(resolved.path!)) {
		return {
			promptPath: profile.promptPath,
			diagnostics: [
				makeDiagnostic(
					"warning",
					"project_prompt_missing",
					`Prompt file not readable: ${prompt.path} (${options.layerScope} ${options.layerPath}) — falling back to the built-in ${profile.name} prompt.`,
					`${fieldPath}.path`,
				),
			],
		};
	}
	return { promptPath: resolved.path!, diagnostics: [] as ProjectConfigDiagnostic[] };
}

interface LayerApplication {
	scope: TeamConfigScope;
	layerRoot: string;
	layerPath: string;
	requireInsideLayerRoot: boolean;
	roles: PartialRawProjectRoleConfigMap;
}

function isLegacyRoleShape(raw: RawProjectRoleConfig): raw is ProjectRoleConfig {
	const maybeLegacy = raw as ProjectRoleConfig & ProjectRoleFlatConfig;
	return maybeLegacy.permissions !== undefined;
}

function isPromptObject(value: unknown): value is ProjectRolePromptConfig {
	return typeof value === "object" && value !== null && "source" in value;
}

function normalizeFlatWritePolicy(write: boolean | undefined): WorkerWritePolicy | undefined {
	if (write === undefined) return undefined;
	return write ? "scoped-write" : "read-only";
}

/**
 * Translate either the v1 nested shape or the v2 flat shape into the internal
 * ProjectRoleConfig used by applyRoleLayer. Flat shape rules:
 * - model: "default" / null / absent → inherit ceiling (internal null).
 * - prompt: "default" / null / absent → builtin. String → treated as project path.
 *   Object form still accepted for parity with v1.
 * - write: true → "scoped-write"; false → "read-only"; absent → inherit.
 * - tools: flat array rolls into permissions.tools.
 * - advanced: { extensionMode, canSpawnWorkers, pathScope } rolls into permissions.
 */
export function normalizeRawRoleConfig(raw: RawProjectRoleConfig): ProjectRoleConfig {
	if (isLegacyRoleShape(raw)) return raw;

	const flat = raw as ProjectRoleFlatConfig;
	const advanced = flat.advanced ?? {};

	const model =
		flat.model === undefined || flat.model === null || flat.model === DEFAULT_MODEL_SENTINEL
			? null
			: flat.model;

	let prompt: ProjectRolePromptConfig;
	if (flat.prompt === undefined || flat.prompt === null || flat.prompt === DEFAULT_PROMPT_SENTINEL) {
		prompt = { source: "builtin", path: null };
	} else if (isPromptObject(flat.prompt)) {
		prompt = flat.prompt;
	} else {
		prompt = { source: "project", path: flat.prompt };
	}

	return {
		description: flat.description ?? null,
		model,
		thinkingLevel: flat.thinkingLevel,
		permissions: {
			tools: flat.tools,
			extensionMode: advanced.extensionMode,
			writePolicy: normalizeFlatWritePolicy(flat.write),
			pathScope: advanced.pathScope,
			canSpawnWorkers: advanced.canSpawnWorkers,
		},
		prompt,
	};
}

function applyRoleLayer(
	ceiling: TeamProfileSpec,
	roleConfig: ProjectRoleConfig,
	layer: LayerApplication,
	profileName: string,
): { profile: TeamProfileSpec; diagnostics: ProjectConfigDiagnostic[] } {
	const diagnostics: ProjectConfigDiagnostic[] = [];
	const permissions = roleConfig.permissions;
	const fieldBase = `roles.${profileName}`;

	const prompt = normalizePromptPath(ceiling, roleConfig, layer.layerRoot, `${fieldBase}.prompt`, {
		requireInsideLayerRoot: layer.requireInsideLayerRoot,
	});
	diagnostics.push(...prompt.diagnostics);

	const resolvedPathScope = normalizePathScope(permissions.pathScope, layer.layerRoot, `${fieldBase}.permissions.pathScope`, {
		requireInsideLayerRoot: layer.requireInsideLayerRoot,
	});
	diagnostics.push(...resolvedPathScope.diagnostics);

	const writePolicy = permissions.writePolicy ?? ceiling.writePolicy;
	if (permissions.writePolicy === "scoped-write" && ceiling.writePolicy === "read-only") {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"write_policy_broaden_forbidden",
				"Project role config may narrow write policy but cannot upgrade a read-only role to scoped-write.",
				`${fieldBase}.permissions.writePolicy`,
			),
		);
	}
	if (writePolicy === "read-only" && resolvedPathScope.pathScope?.allowWrite) {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"read_only_scope_write_forbidden",
				"Read-only roles cannot declare a writable path scope.",
				`${fieldBase}.permissions.pathScope.allowWrite`,
			),
		);
	}
	if (permissions.tools && permissions.tools.some((tool) => !ceiling.tools.includes(tool))) {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"tools_broaden_forbidden",
				"Project role config may only remove tools from the default role; it cannot add new tools.",
				`${fieldBase}.permissions.tools`,
			),
		);
	}
	const extensionMode = permissions.extensionMode ?? ceiling.extensionMode;
	if (permissions.extensionMode && !isExtensionModeNarrowerOrEqual(extensionMode, ceiling.extensionMode)) {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"extension_mode_broaden_forbidden",
				"Project role config may only keep or narrow extension mode rights; inherit is not allowed here.",
				`${fieldBase}.permissions.extensionMode`,
			),
		);
	}
	if (permissions.canSpawnWorkers === true && !ceiling.canSpawnWorkers) {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"spawn_workers_broaden_forbidden",
				"Project role config cannot grant worker-spawning rights to a role that defaults to false.",
				`${fieldBase}.permissions.canSpawnWorkers`,
			),
		);
	}
	if (resolvedPathScope.pathScope && !isPathScopeNarrowerOrEqual(resolvedPathScope.pathScope, ceiling.pathScope)) {
		diagnostics.push(
			makeDiagnostic(
				"error",
				"path_scope_broaden_forbidden",
				"Project role config may only narrow the default path scope; it cannot broaden it.",
				`${fieldBase}.permissions.pathScope`,
			),
		);
	}

	const nextProfile: TeamProfileSpec = {
		...cloneProfile(ceiling),
		description: roleConfig.description ?? ceiling.description,
		model: roleConfig.model ?? ceiling.model,
		thinkingLevel: roleConfig.thinkingLevel ?? ceiling.thinkingLevel,
		tools: permissions.tools ? [...permissions.tools] : [...ceiling.tools],
		promptPath: prompt.promptPath,
		extensionMode,
		writePolicy,
		pathScope: resolvedPathScope.pathScope ?? clonePathScope(ceiling.pathScope),
		canSpawnWorkers: permissions.canSpawnWorkers ?? ceiling.canSpawnWorkers,
	};

	return { profile: nextProfile, diagnostics };
}

export function findNearestProjectConfigPath(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = resolve(current, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function getGlobalProjectConfigPath(): string {
	return resolve(homedir(), TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

export function findGlobalProjectConfigPath(): string | undefined {
	const candidate = getGlobalProjectConfigPath();
	return existsSync(candidate) ? candidate : undefined;
}

export function getProjectConfigPathForScope(scope: TeamConfigScope, cwd: string): string {
	if (scope === "global") return getGlobalProjectConfigPath();
	return resolve(cwd, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

interface ParsedLayer {
	scope: TeamConfigScope;
	path: string;
	layerRoot: string;
	requireInsideLayerRoot: boolean;
	parsed: TeamProjectConfigFile;
	diagnostics: ProjectConfigDiagnostic[];
}

function computeLayerRoot(scope: TeamConfigScope, path: string): string {
	if (scope === "project") {
		// Config lives at <projectRoot>/.pi/agent/agents-team.json → root is two dirs up.
		return dirname(dirname(dirname(path)));
	}
	return dirname(path);
}

function parseLayer(scope: TeamConfigScope, path: string): ParsedLayer | { fatalDiagnostics: ProjectConfigDiagnostic[]; scope: TeamConfigScope; path: string } {
	const layerRoot = computeLayerRoot(scope, path);
	const requireInsideLayerRoot = scope === "project";

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			scope,
			path,
			fatalDiagnostics: [
				makeDiagnostic(
					"error",
					"project_config_parse_failed",
					`Could not parse ${scope} ${TEAM_PROJECT_CONFIG_FILE} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
				),
			],
		};
	}

	const schemaErrors = Array.from(Value.Errors(TeamProjectConfigSchema, parsedJson), (error) =>
		makeDiagnostic("error", `schema_${error.type}`, `${scope} config: ${error.message}`, error.path || undefined),
	);
	if (schemaErrors.length > 0) {
		return { scope, path, fatalDiagnostics: schemaErrors };
	}

	return {
		scope,
		path,
		layerRoot,
		requireInsideLayerRoot,
		parsed: parsedJson as TeamProjectConfigFile,
		diagnostics: [],
	};
}

function isFatalLayerParse(value: ParsedLayer | { fatalDiagnostics: ProjectConfigDiagnostic[] }): value is { fatalDiagnostics: ProjectConfigDiagnostic[]; scope: TeamConfigScope; path: string } {
	return "fatalDiagnostics" in value;
}

export interface LoadActiveTeamConfigOptions {
	cwd: string;
	baseConfig?: TeamConfig;
	/**
	 * Override the global config lookup.
	 * - `undefined` (default): probe `~/.pi/agent/agents-team.json`.
	 * - `null`: skip the global probe entirely (used by tests for isolation).
	 * - `string`: treat this as the global config path; load if the file exists.
	 */
	globalConfigPath?: string | null;
}

export function loadActiveTeamConfig(options: LoadActiveTeamConfigOptions = { cwd: process.cwd() }): LoadedTeamProjectConfig {
	const baseConfig = cloneTeamConfig(options.baseConfig ?? DEFAULT_TEAM_CONFIG);

	let globalPath: string | undefined;
	if (options.globalConfigPath === null) {
		globalPath = undefined;
	} else if (typeof options.globalConfigPath === "string") {
		globalPath = existsSync(options.globalConfigPath) ? options.globalConfigPath : undefined;
	} else {
		const envOverride = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		if (envOverride !== undefined) {
			if (envOverride === "" || envOverride === "null" || envOverride === "none") {
				globalPath = undefined;
			} else {
				globalPath = existsSync(envOverride) ? envOverride : undefined;
			}
		} else {
			globalPath = findGlobalProjectConfigPath();
		}
	}
	const projectPath = findNearestProjectConfigPath(options.cwd);

	const layers: TeamProjectConfigLayer[] = [];
	const diagnostics: ProjectConfigDiagnostic[] = [];
	const parsedLayers: ParsedLayer[] = [];
	let anyFatal = false;

	for (const [scope, path] of [["global", globalPath], ["project", projectPath]] as const) {
		if (!path) continue;
		const result = parseLayer(scope, path);
		if (isFatalLayerParse(result)) {
			diagnostics.push(...result.fatalDiagnostics);
			layers.push({ scope: result.scope, path: result.path });
			anyFatal = true;
			continue;
		}
		parsedLayers.push(result);
		const layerDefaultsVersion = typeof result.parsed.defaultsVersion === "number" ? result.parsed.defaultsVersion : undefined;
		layers.push({
			scope: result.scope,
			path: result.path,
			enabled: result.parsed.enabled,
			defaultsVersion: layerDefaultsVersion,
			defaultsStale: layerDefaultsVersion !== undefined && layerDefaultsVersion !== CURRENT_DEFAULTS_VERSION,
		});
	}

	let enabled = true;
	let enabledSource: TeamEnabledSource = "default";
	for (const layer of layers) {
		if (layer.enabled === undefined) continue;
		enabled = layer.enabled;
		enabledSource = layer.scope;
	}

	if (anyFatal) {
		return {
			status: "invalid",
			config: baseConfig,
			sourcePath: projectPath ?? globalPath,
			projectRoot: projectPath ? computeLayerRoot("project", projectPath) : undefined,
			layers,
			enabled,
			enabledSource,
			diagnostics,
			delegationEnabled: false,
		};
	}

	let profiles = baseConfig.profiles.map(cloneProfile);
	for (const layer of parsedLayers) {
		const roles = layer.parsed.roles ?? {};
		profiles = profiles.map((profile) => {
			const roleConfig = roles[profile.name as keyof typeof roles];
			if (!roleConfig) return profile;
			const application: LayerApplication = {
				scope: layer.scope,
				layerRoot: layer.layerRoot,
				requireInsideLayerRoot: layer.requireInsideLayerRoot,
				roles,
			};
			const normalized = applyRoleLayer(profile, roleConfig, application, profile.name);
			diagnostics.push(...normalized.diagnostics);
			return normalized.profile;
		});
	}

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return {
			status: "invalid",
			config: baseConfig,
			sourcePath: projectPath ?? globalPath,
			projectRoot: projectPath ? computeLayerRoot("project", projectPath) : undefined,
			layers,
			enabled,
			enabledSource,
			diagnostics,
			delegationEnabled: false,
		};
	}

	if (parsedLayers.length === 0) {
		return {
			status: "builtin",
			config: baseConfig,
			layers,
			enabled,
			enabledSource,
			diagnostics,
			delegationEnabled: true,
		};
	}

	for (const layer of layers) {
		diagnostics.unshift(
			makeDiagnostic("info", "project_config_loaded", `Loaded ${layer.scope} ${TEAM_PROJECT_CONFIG_FILE} from ${layer.path}`),
		);
	}

	const projectRoot = projectPath ? computeLayerRoot("project", projectPath) : undefined;

	return {
		status: "project",
		config: {
			...baseConfig,
			safety: {
				...baseConfig.safety,
				allowProjectProfiles: true,
				projectRoot,
			},
			profiles,
		},
		sourcePath: projectPath ?? globalPath,
		projectRoot,
		layers,
		enabled,
		enabledSource,
		diagnostics,
		delegationEnabled: true,
	};
}

export function formatProjectConfigDiagnostics(result: LoadedTeamProjectConfig): string {
	if (result.diagnostics.length === 0) return "No project config diagnostics.";
	return result.diagnostics
		.filter((diagnostic) => PROJECT_CONFIG_DIAGNOSTIC_SEVERITIES.includes(diagnostic.severity))
		.map((diagnostic) => `${diagnostic.severity.toUpperCase()}: ${diagnostic.message}${diagnostic.fieldPath ? ` (${diagnostic.fieldPath})` : ""}`)
		.join("\n");
}

export function isProjectConfigStatus(value: string): value is LoadedTeamProjectConfig["status"] {
	return PROJECT_CONFIG_STATUSES.includes(value as LoadedTeamProjectConfig["status"]);
}

export const _internalProjectConfigPaths = {
	TEAM_PROJECT_CONFIG_DIR,
	TEAM_PROJECT_CONFIG_FILE,
	TEAM_PROJECT_CONFIG_RELATIVE_PATH,
};
