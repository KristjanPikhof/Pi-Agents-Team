import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { DEFAULT_TEAM_CONFIG, TeamProjectConfigSchema } from "../config";
import {
	PROJECT_CONFIG_DIAGNOSTIC_SEVERITIES,
	PROJECT_CONFIG_STATUSES,
	TEAM_PROJECT_CONFIG_FILE,
	type LoadedTeamProjectConfig,
	type ProjectConfigDiagnostic,
	type ProjectRoleConfig,
	type TeamConfig,
	type TeamPathScope,
	type TeamProfileSpec,
	type TeamProjectConfigFile,
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

function makeResult(
	status: LoadedTeamProjectConfig["status"],
	config: TeamConfig,
	diagnostics: ProjectConfigDiagnostic[] = [],
	options: Pick<LoadedTeamProjectConfig, "sourcePath" | "projectRoot"> = {},
): LoadedTeamProjectConfig {
	return {
		status,
		config,
		sourcePath: options.sourcePath,
		projectRoot: options.projectRoot,
		diagnostics,
		delegationEnabled: status !== "invalid",
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

function isPathInsideRoot(targetPath: string, root: string): boolean {
	const rel = relative(root, targetPath);
	return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function resolveProjectPath(projectRoot: string, value: string, fieldPath: string): { path?: string; diagnostic?: ProjectConfigDiagnostic } {
	const resolved = resolve(projectRoot, value);
	if (!isPathInsideRoot(resolved, projectRoot)) {
		return {
			diagnostic: makeDiagnostic("error", "project_path_escape", `Resolved path must stay within the project root: ${value}`, fieldPath),
		};
	}
	return { path: resolved };
}

function normalizePathScope(pathScope: TeamPathScope | undefined, projectRoot: string, fieldPath: string) {
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
		const resolved = resolveProjectPath(projectRoot, root, `${fieldPath}.roots[${index}]`);
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
	projectRoot: string,
	fieldPath: string,
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

	const resolved = resolveProjectPath(projectRoot, prompt.path, `${fieldPath}.path`);
	if (resolved.diagnostic) {
		return { promptPath: profile.promptPath, diagnostics: [resolved.diagnostic] };
	}
	if (!existsSync(resolved.path!)) {
		return {
			promptPath: profile.promptPath,
			diagnostics: [makeDiagnostic("error", "project_prompt_missing", `Prompt file does not exist: ${prompt.path}`, `${fieldPath}.path`)],
		};
	}
	return { promptPath: resolved.path!, diagnostics: [] as ProjectConfigDiagnostic[] };
}

function normalizeProfile(
	profile: TeamProfileSpec,
	roleConfig: ProjectRoleConfig,
	projectRoot: string,
): { profile: TeamProfileSpec; diagnostics: ProjectConfigDiagnostic[] } {
	const diagnostics: ProjectConfigDiagnostic[] = [];
	const permissions = roleConfig.permissions;
	const fieldBase = `roles.${profile.name}`;

	const prompt = normalizePromptPath(profile, roleConfig, projectRoot, `${fieldBase}.prompt`);
	diagnostics.push(...prompt.diagnostics);

	const resolvedPathScope = normalizePathScope(permissions.pathScope, projectRoot, `${fieldBase}.permissions.pathScope`);
	diagnostics.push(...resolvedPathScope.diagnostics);

	const writePolicy = permissions.writePolicy ?? profile.writePolicy;
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

	const nextProfile: TeamProfileSpec = {
		...cloneProfile(profile),
		description: roleConfig.description ?? profile.description,
		model: roleConfig.model ?? profile.model,
		thinkingLevel: roleConfig.thinkingLevel ?? profile.thinkingLevel,
		tools: permissions.tools ? [...permissions.tools] : [...profile.tools],
		promptPath: prompt.promptPath,
		extensionMode: permissions.extensionMode ?? profile.extensionMode,
		writePolicy,
		pathScope: resolvedPathScope.pathScope ?? clonePathScope(profile.pathScope),
		canSpawnWorkers: permissions.canSpawnWorkers ?? profile.canSpawnWorkers,
	};

	return { profile: nextProfile, diagnostics };
}

export function findNearestProjectConfigPath(cwd: string, fileName = TEAM_PROJECT_CONFIG_FILE): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const candidate = resolve(current, fileName);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function loadActiveTeamConfig(options: { cwd: string; baseConfig?: TeamConfig } = { cwd: process.cwd() }): LoadedTeamProjectConfig {
	const baseConfig = cloneTeamConfig(options.baseConfig ?? DEFAULT_TEAM_CONFIG);
	const sourcePath = findNearestProjectConfigPath(options.cwd);
	if (!sourcePath) {
		return makeResult("builtin", baseConfig);
	}

	const projectRoot = dirname(sourcePath);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(readFileSync(sourcePath, "utf8"));
	} catch (error) {
		return makeResult(
			"invalid",
			baseConfig,
			[
				makeDiagnostic(
					"error",
					"project_config_parse_failed",
					`Could not parse ${TEAM_PROJECT_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
				),
			],
			{ sourcePath, projectRoot },
		);
	}

	const schemaErrors = Array.from(Value.Errors(TeamProjectConfigSchema, parsedJson), (error) =>
		makeDiagnostic("error", `schema_${error.type}`, error.message, error.path || undefined),
	);
	if (schemaErrors.length > 0) {
		return makeResult("invalid", baseConfig, schemaErrors, { sourcePath, projectRoot });
	}

	const projectConfig = parsedJson as TeamProjectConfigFile;
	const diagnostics: ProjectConfigDiagnostic[] = [];
	const profiles = baseConfig.profiles.map((profile) => {
		const normalized = normalizeProfile(profile, projectConfig.roles[profile.name as keyof typeof projectConfig.roles], projectRoot);
		diagnostics.push(...normalized.diagnostics);
		return normalized.profile;
	});

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return makeResult("invalid", baseConfig, diagnostics, { sourcePath, projectRoot });
	}

	return makeResult(
		"project",
		{
			...baseConfig,
			safety: {
				...baseConfig.safety,
				allowProjectProfiles: true,
			},
			profiles,
		},
		[
			makeDiagnostic("info", "project_config_loaded", `Loaded session-frozen project config from ${sourcePath}`),
			...diagnostics,
		],
		{ sourcePath, projectRoot },
	);
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
