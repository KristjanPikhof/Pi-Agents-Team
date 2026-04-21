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
		schemaVersion: 3,
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

test("loadActiveTeamConfig v2: user role declarations are source-of-truth (no ceiling comparisons)", () => {
	// In schema v2 the user's JSON owns the role list. There's no concept of a
	// built-in "ceiling" to compare against — role names are free-form and tools
	// are whatever the user declared. Platform-level safety (extensionMode
	// "inherit" block, pathScope required for writes) is still enforced at
	// delegate time via launch-policy, not here in the loader.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v2-freeform-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
		roles: {
			reviewer: {
				tools: ["read", "edit", "bash", "grep", "find"],
				write: true,
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.ok(reviewer);
	assert.deepEqual(reviewer?.tools, ["read", "edit", "bash", "grep", "find"]);
	assert.equal(reviewer?.writePolicy, "scoped-write");
	// No narrowing diagnostics emitted under v2
	assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "tools_broaden_forbidden"));
});

test("loadActiveTeamConfig v2: extensionMode 'inherit' in role advanced block is rejected (platform safety)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v2-recursion-block-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
		roles: {
			reviewer: {
				tools: ["read", "grep"],
				write: false,
				advanced: { extensionMode: "inherit" },
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "extension_mode_inherit_forbidden"));
});

test("loadActiveTeamConfig accepts a partial roles map (no required role keys)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-partial-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { schemaVersion: 3, roles: { fixer: { permissions: {}, prompt: { source: "builtin" } } } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.enabled, true);
});

test("loadActiveTeamConfig resolves enabled flag by precedence (project over global)", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-enabled-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, { schemaVersion: 3, enabled: true });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, JSON.stringify({ schemaVersion: 3, enabled: false }));

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
	writeFileSync(globalPath, JSON.stringify({ schemaVersion: 3, enabled: false }));

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

test("loadActiveTeamConfig v2: project file fully replaces global — no cross-layer merging", () => {
	// In schema v2 the winning layer owns the role list outright. If a project
	// file is present, global is ignored entirely. This is a deliberate change
	// from earlier layered-narrowing semantics — roles are too free-form for
	// cross-layer merging to be meaningful.
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-replace-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, {
		schemaVersion: 3,
		roles: {
			oracle: { thinkingLevel: "medium" } as any,
			worker: { tools: ["read", "bash"], write: false } as any,
		},
	});

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-replace-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(
		globalPath,
		JSON.stringify({
			schemaVersion: 3,
			roles: {
				oracle: { model: "openai/gpt-5.4", thinkingLevel: "high" },
				globalOnlyRole: { tools: ["read"], write: false },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	const oracle = result.config.profiles.find((profile) => profile.name === "oracle");
	assert.equal(oracle?.thinkingLevel, "medium");
	assert.equal(oracle?.model, undefined, "project wins — global's model must not leak through");
	// Project declared its own role names; global's globalOnlyRole must not appear
	assert.ok(!result.config.profiles.find((profile) => profile.name === "globalOnlyRole"));
	assert.ok(result.config.profiles.find((profile) => profile.name === "worker"));
});

test("loadActiveTeamConfig accepts the flat v2 role shape (tools / write / prompt / advanced)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-flat-shape-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
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

test("loadActiveTeamConfig v2: a string prompt that doesn't resolve to a file is stored as inline text", () => {
	// User writes `"prompt": "You are a specialized agent..."` directly in JSON.
	// Since no file matches that string, the loader treats it as inline prompt
	// text and surfaces it via promptInline. This is the user's escape hatch for
	// per-repo role prompts without having to create a .md file.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-inline-prompt-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
		roles: {
			"custom-scout": {
				description: "Fast repo recon.",
				tools: ["read", "grep", "find", "ls"],
				write: false,
				prompt: "You are a specialized repo-recon agent. Return file paths only.",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	const scout = result.config.profiles.find((profile) => profile.name === "custom-scout");
	assert.ok(scout);
	assert.equal(scout?.promptInline, "You are a specialized repo-recon agent. Return file paths only.");
});

test("loadActiveTeamConfig v2: custom role name with prompt 'default' uses the generic-worker sentinel", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-custom-default-prompt-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
		roles: {
			"custom-name": {
				description: "A totally custom worker.",
				tools: ["read"],
				write: false,
				prompt: "default",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const role = result.config.profiles.find((profile) => profile.name === "custom-name");
	assert.equal(role?.promptPath, "<generic-worker>");
	assert.equal(role?.promptInline, undefined);
});

test("loadActiveTeamConfig v2: project file with schema mismatch does NOT let global take over (precedence by presence)", () => {
	// Finding-1 guarantee: a stale local project config must not silently
	// resurface broader global roles. Project wins by presence. If project is
	// mismatched, the loader falls back to built-in defaults, never to global.
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-finding1-project-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	// Write a project file with an obsolete schemaVersion (v2 instead of current v3)
	const projectPath = projectConfigPath(projectRoot);
	mkdirSync(resolve(projectPath, ".."), { recursive: true });
	writeFileSync(
		projectPath,
		JSON.stringify({
			schemaVersion: 2,
			roles: { "project-only": { tools: ["read"], write: false } },
		}),
	);

	// Global config has a VALID schemaVersion and a different role set —
	// including a write-capable role. Under the old bug, this global config
	// would take over for the project, exposing write capabilities the project
	// never sanctioned.
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-finding1-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(
		globalPath,
		JSON.stringify({
			schemaVersion: 3,
			roles: {
				"global-only-writer": { tools: ["read", "edit", "write"], write: true },
			},
		}),
	);

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	// Must NOT be "project" (project was mismatched). Must NOT pick up global either.
	// Status is "builtin" — fall back to the packaged seven roles.
	assert.equal(result.status, "builtin");
	assert.equal(result.delegationEnabled, true);
	assert.ok(!result.config.profiles.find((p) => p.name === "global-only-writer"), "global role must not leak in");
	assert.ok(result.config.profiles.find((p) => p.name === "fixer"), "built-in seven should be the fallback");
	assert.ok(
		result.diagnostics.some((d) => d.code === "schema_version_mismatch" && d.message.includes("project")),
		"schema mismatch warning for project layer should be present",
	);
});

test("loadActiveTeamConfig v2: whenToUse is the canonical field; description is accepted as legacy alias; whenToUse wins", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-whentouse-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 3,
		roles: {
			scout: {
				whenToUse: "Use when the user wants a fast API route map.",
				tools: ["read", "grep"],
				write: false,
			} as any,
			legacy: {
				description: "Legacy description field.",
				tools: ["read"],
				write: false,
			} as any,
			both: {
				whenToUse: "This one wins.",
				description: "This one is the alias fallback.",
				tools: ["read"],
				write: false,
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const scout = result.config.profiles.find((p) => p.name === "scout");
	assert.equal(scout?.description, "Use when the user wants a fast API route map.");
	const legacy = result.config.profiles.find((p) => p.name === "legacy");
	assert.equal(legacy?.description, "Legacy description field.");
	const both = result.config.profiles.find((p) => p.name === "both");
	assert.equal(both?.description, "This one wins.");
});

test("loadActiveTeamConfig v2: schema version mismatch warns and falls back to built-in", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v1-file-"));
	mkdirSync(join(root, "app"), { recursive: true });
	// Write a file with schema version 1 — obsolete under v2
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, enabled: true, roles: {} }, null, 2));

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "builtin", "unsupported schema version falls back to built-in roles");
	assert.equal(result.delegationEnabled, true);
	const mismatch = result.diagnostics.find((diagnostic) => diagnostic.code === "schema_version_mismatch");
	assert.ok(mismatch, "expected a schema_version_mismatch warning");
	assert.equal(mismatch?.severity, "warning");
	assert.match(mismatch!.message, /\/team-init local --force/);
	const layer = result.layers.find((entry) => entry.scope === "project");
	assert.equal(layer?.schemaMismatch, true);
	assert.equal(layer?.rawSchemaVersion, 1);
});

test("loadActiveTeamConfig marks config invalid if any layer fails to parse", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-invalid-global-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, { schemaVersion: 3, roles: {} });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-invalid-global-dir-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, "{not json");

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "project_config_parse_failed"));
});
