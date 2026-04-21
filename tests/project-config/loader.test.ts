import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_PROFILE_NAMES, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE, type TeamProjectConfigFile } from "../../src/types";
import { loadActiveTeamConfig } from "../../src/project-config/loader";

function projectConfigPath(root: string): string {
	return join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

function writeProjectConfig(root: string, config: TeamProjectConfigFile): string {
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

function buildConfig(overrides: Partial<TeamProjectConfigFile["roles"]> = {}): TeamProjectConfigFile {
	const roles = Object.fromEntries(
		TEAM_PROFILE_NAMES.map((profileName) => [
			profileName,
			{
				permissions: {},
				prompt: { source: "builtin" as const },
			},
		]),
	) as TeamProjectConfigFile["roles"];
	return {
		version: 2,
		roles: {
			...roles,
			...overrides,
		},
	};
}

test("loadActiveTeamConfig discovers nearest ancestor config and normalizes project paths", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-"));
	const nestedCwd = join(root, "packages", "demo");
	mkdirSync(join(root, "prompts"), { recursive: true });
	mkdirSync(join(root, "src", "scoped"), { recursive: true });
	mkdirSync(nestedCwd, { recursive: true });
	writeFileSync(join(root, "prompts", "reviewer.md"), "# reviewer override\n");
	const configPath = writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				permissions: {},
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
			fixer: {
				permissions: {
					writePolicy: "scoped-write",
					pathScope: {
						roots: ["src/scoped"],
						allowReadOutsideRoots: false,
						allowWrite: true,
					},
				},
				prompt: { source: "builtin" },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: nestedCwd, globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.enabled, true);
	assert.equal(result.enabledSource, "default");
	assert.equal(result.sourcePath, configPath);
	assert.equal(result.projectRoot, root);
	assert.equal(result.layers.length, 1);
	assert.equal(result.layers[0]?.scope, "project");
	assert.ok(result.diagnostics.some((diagnostic) => /Loaded project agents-team\.json/.test(diagnostic.message)));

	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.promptPath, join(root, "prompts", "reviewer.md"));

	const fixer = result.config.profiles.find((profile) => profile.name === "fixer");
	assert.deepEqual(fixer?.pathScope?.roots, [join(root, "src", "scoped")]);
	assert.equal(result.config.safety.allowProjectProfiles, true);
});

test("loadActiveTeamConfig prefers the nearest ancestor config when multiple exist", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-nearest-"));
	const parentApp = join(root, "packages");
	const nestedRoot = join(parentApp, "demo");
	const nestedCwd = join(nestedRoot, "src");
	mkdirSync(join(root, "prompts"), { recursive: true });
	mkdirSync(join(nestedRoot, "prompts"), { recursive: true });
	mkdirSync(nestedCwd, { recursive: true });
	writeFileSync(join(root, "prompts", "reviewer.md"), "# parent reviewer override\n");
	writeFileSync(join(nestedRoot, "prompts", "reviewer.md"), "# child reviewer override\n");
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				permissions: {},
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
		}),
	);
	const nestedPath = writeProjectConfig(
		nestedRoot,
		buildConfig({
			reviewer: {
				permissions: {},
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: nestedCwd, globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.sourcePath, nestedPath);
	assert.equal(result.projectRoot, nestedRoot);
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.promptPath, join(nestedRoot, "prompts", "reviewer.md"));
	assert.doesNotMatch(reviewer?.promptPath ?? "", /packages\/prompts\/reviewer\.md$/);
});

test("loadActiveTeamConfig disables delegation when project paths escape the discovered root", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-invalid-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				permissions: {},
				prompt: { source: "project", path: "../outside.md" },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => /within the project root/.test(diagnostic.message)));
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.match(reviewer?.promptPath ?? "", /prompts\/agents\/reviewer\.md$/);
});

test("loadActiveTeamConfig rejects project role widening of default rights", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-widen-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				permissions: {
					tools: ["read", "edit"],
					extensionMode: "inherit",
					writePolicy: "scoped-write",
					pathScope: {
						roots: ["app"],
						allowReadOutsideRoots: false,
						allowWrite: true,
					},
					canSpawnWorkers: true,
				},
				prompt: { source: "builtin" },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "tools_broaden_forbidden"));
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "extension_mode_broaden_forbidden"));
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "write_policy_broaden_forbidden"));
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "spawn_workers_broaden_forbidden"));
});

test("loadActiveTeamConfig accepts a partial roles map (no required role keys)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-partial-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { version: 2, roles: { fixer: { permissions: {}, prompt: { source: "builtin" } } } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.enabled, true);
});

test("loadActiveTeamConfig resolves enabled flag by precedence (project over global)", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-enabled-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, { version: 2, enabled: true });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, JSON.stringify({ version: 2, enabled: false }));

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.enabled, true);
	assert.equal(result.enabledSource, "project");
	assert.equal(result.layers.length, 2);
});

test("loadActiveTeamConfig applies global enabled=false when project has no override", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-enabled-global-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, JSON.stringify({ version: 2, enabled: false }));

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.enabled, false);
	assert.equal(result.enabledSource, "global");
});

test("loadActiveTeamConfig defaults enabled=true when no layers set it", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-enabled-default-"));
	mkdirSync(join(root, "app"), { recursive: true });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.enabled, true);
	assert.equal(result.enabledSource, "default");
	assert.equal(result.status, "builtin");
});

test("loadActiveTeamConfig layers project config on top of global with rights narrowing", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-layered-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, {
		version: 2,
		roles: {
			oracle: { thinkingLevel: "medium", permissions: {}, prompt: { source: "builtin" } },
		},
	});

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-layered-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(
		globalPath,
		JSON.stringify({
			version: 2,
			roles: {
				oracle: { model: "openai/gpt-5.4", thinkingLevel: "high", permissions: {}, prompt: { source: "builtin" } },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	const oracle = result.config.profiles.find((profile) => profile.name === "oracle");
	assert.equal(oracle?.model, "openai/gpt-5.4");
	assert.equal(oracle?.thinkingLevel, "medium");
});

test("loadActiveTeamConfig accepts the flat v2 role shape (tools / write / prompt / advanced)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-flat-shape-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		version: 2,
		defaultsVersion: 2,
		roles: {
			// flat role: tools/write/prompt at the top level, no `permissions` wrapper
			reviewer: {
				description: "custom",
				model: "default",
				thinkingLevel: "high",
				tools: ["read", "grep", "find", "ls"],
				write: false,
				prompt: "default",
			} as any,
			// write:true should translate to writePolicy scoped-write
			fixer: {
				tools: ["read", "bash", "edit", "write"],
				write: true,
				prompt: "default",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);

	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.ok(reviewer);
	assert.equal(reviewer?.description, "custom");
	assert.equal(reviewer?.thinkingLevel, "high");
	assert.deepEqual(reviewer?.tools, ["read", "grep", "find", "ls"]);
	assert.equal(reviewer?.writePolicy, "read-only");
	assert.equal(reviewer?.model, undefined, "model:'default' should map to undefined (inherit)");

	const fixer = result.config.profiles.find((profile) => profile.name === "fixer");
	assert.ok(fixer);
	assert.equal(fixer?.writePolicy, "scoped-write");
	assert.deepEqual(fixer?.tools, ["read", "bash", "edit", "write"]);
});

test("loadActiveTeamConfig warns (not errors) when a flat prompt path is unreadable and keeps the builtin", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-missing-prompt-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		version: 2,
		roles: {
			reviewer: {
				tools: ["read", "grep", "find", "ls", "bash"],
				write: false,
				prompt: "prompts/custom-reviewer.md",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project", "missing prompt file must not invalidate the whole layer");
	assert.equal(result.delegationEnabled, true);
	const missingWarning = result.diagnostics.find((diagnostic) => diagnostic.code === "project_prompt_missing");
	assert.ok(missingWarning, "expected a project_prompt_missing warning");
	assert.equal(missingWarning?.severity, "warning");
	assert.match(missingWarning!.message, /custom-reviewer\.md/);
	assert.match(missingWarning!.message, /falling back/i);

	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.ok(reviewer?.promptPath);
	assert.match(reviewer!.promptPath, /prompts\/agents\/reviewer\.md$/, "should fall back to the built-in reviewer prompt path");
});

test("loadActiveTeamConfig marks config invalid if any layer fails to parse", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-invalid-global-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, { version: 2, roles: {} });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-invalid-global-dir-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, "{not json");

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "project_config_parse_failed"));
});
