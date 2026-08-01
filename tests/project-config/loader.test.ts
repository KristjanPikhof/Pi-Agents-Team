import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_PROFILE_NAMES, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE, TEAM_SCAFFOLD_VERSION, type TeamProjectConfigFile } from "../../src/types";
import { loadActiveTeamConfig } from "../../src/project-config/loader";
import { loadWorkerPrompt } from "../../src/prompts/contracts";
import { applyLaunchPolicy } from "../../src/safety/launch-policy";

function projectConfigPath(root: string): string {
	return join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

function writeProjectConfig(root: string, config: TeamProjectConfigFile): string {
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

function writeGlobalConfig(config: Partial<TeamProjectConfigFile> | Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-global-"));
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const path = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

function buildConfig(overrides: Partial<TeamProjectConfigFile["roles"]> = {}): TeamProjectConfigFile {
	const roles = Object.fromEntries(
		TEAM_PROFILE_NAMES.map((profileName) => [
			profileName,
			{
				prompt: "default",
			},
		]),
	) as TeamProjectConfigFile["roles"];
	return {
		schemaVersion: 4,
		roles: {
			...roles,
			...overrides,
		},
	};
}

function linkSelfExtensionEntrypoint(root: string, source: string): void {
	const relativeSource = source.replace(/^\.\//, "");
	if (relativeSource !== "extensions" && !relativeSource.startsWith("extensions/")) return;
	const linkPath = join(root, relativeSource);
	const targetPath = resolve(process.cwd(), relativeSource);
	mkdirSync(resolve(linkPath, ".."), { recursive: true });
	symlinkSync(targetPath, linkPath, /\.(?:[cm]?[jt]s)$/.test(targetPath) ? "file" : "dir");
}

test("loadActiveTeamConfig exposes project active freshness metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-active-local-"));
	mkdirSync(join(root, "app"), { recursive: true });
	const configPath = writeProjectConfig(root, { schemaVersion: 4, scaffoldVersion: TEAM_SCAFFOLD_VERSION, roles: { fixer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.sourcePath, configPath);
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: configPath,
		parseStatus: "valid",
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		scaffoldVersionMissing: false,
		scaffoldStale: false,
		rawSchemaVersion: 4,
	});
});

test("loadActiveTeamConfig exposes global-only active freshness metadata", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-active-global-cwd-"));
	const globalPath = writeGlobalConfig({ schemaVersion: 4, scaffoldVersion: TEAM_SCAFFOLD_VERSION, roles: { reviewer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({ cwd, globalConfigPath: globalPath });
	assert.equal(result.sourcePath, globalPath);
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "layer",
		scope: "global",
		path: globalPath,
		parseStatus: "valid",
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		scaffoldVersionMissing: false,
		scaffoldStale: false,
		rawSchemaVersion: 4,
	});
});

test("loadActiveTeamConfig exposes no active freshness target when no config exists", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-active-none-"));

	const result = loadActiveTeamConfig({ cwd, globalConfigPath: null });
	assert.equal(result.sourcePath, undefined);
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "none",
		parseStatus: "none",
		scaffoldVersionMissing: false,
		scaffoldStale: false,
	});
});

test("loadActiveTeamConfig active freshness follows project precedence over global", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-active-project-wins-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	const projectPath = writeProjectConfig(projectRoot, { schemaVersion: 4, scaffoldVersion: TEAM_SCAFFOLD_VERSION, roles: { fixer: { prompt: "default" } } });
	const globalPath = writeGlobalConfig({ schemaVersion: 4, scaffoldVersion: 0, roles: { reviewer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.sourcePath, projectPath);
	assert.equal(result.activeConfigFreshness.kind, "layer");
	if (result.activeConfigFreshness.kind === "layer") {
		assert.equal(result.activeConfigFreshness.scope, "project");
		assert.equal(result.activeConfigFreshness.path, projectPath);
		assert.equal(result.activeConfigFreshness.scaffoldStale, false);
	}
});

test("loadActiveTeamConfig skips project config when project trust is false", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-untrusted-project-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, {
		schemaVersion: 4,
		enabled: false,
		roles: {
			"project-only": { access: { tools: ["read"], write: false } } as any,
		},
	});
	const globalPath = writeGlobalConfig({ schemaVersion: 4, scaffoldVersion: TEAM_SCAFFOLD_VERSION, roles: { reviewer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({
		cwd: join(projectRoot, "app"),
		globalConfigPath: globalPath,
		projectConfigTrusted: false,
	});

	assert.equal(result.status, "project", "global config still loads through the existing project status shape");
	assert.equal(result.sourcePath, globalPath);
	assert.equal(result.enabled, true, "untrusted project enabled:false must not disable delegation");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.layers.length, 1);
	assert.equal(result.layers[0]?.scope, "global");
	assert.ok(!result.config.profiles.find((profile) => profile.name === "project-only"), "untrusted project roles must not be injected");
	assert.ok(result.config.profiles.find((profile) => profile.name === "reviewer"));
});

test("loadActiveTeamConfig active freshness reports schema-mismatched project with stale scaffold while preserving sourcePath", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-active-mismatch-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	const projectPath = projectConfigPath(projectRoot);
	mkdirSync(resolve(projectPath, ".."), { recursive: true });
	writeFileSync(projectPath, JSON.stringify({ schemaVersion: 3, scaffoldVersion: 0, roles: {} }, null, 2));
	const globalPath = writeGlobalConfig({ schemaVersion: 4, scaffoldVersion: TEAM_SCAFFOLD_VERSION, roles: { reviewer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "builtin");
	assert.equal(result.sourcePath, undefined, "builtin fallback sourcePath semantics are preserved for mismatched project");
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: projectPath,
		parseStatus: "schema-mismatch",
		scaffoldVersion: 0,
		scaffoldVersionMissing: false,
		scaffoldStale: true,
		rawSchemaVersion: 3,
	});
});

test("loadActiveTeamConfig active freshness distinguishes missing scaffoldVersion from stale numeric scaffoldVersion", () => {
	const missingRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-active-missing-scaffold-"));
	mkdirSync(join(missingRoot, "app"), { recursive: true });
	const missingPath = writeProjectConfig(missingRoot, { schemaVersion: 4, roles: { fixer: { prompt: "default" } } });
	const staleRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-active-stale-scaffold-"));
	mkdirSync(join(staleRoot, "app"), { recursive: true });
	const stalePath = writeProjectConfig(staleRoot, { schemaVersion: 4, scaffoldVersion: 0, roles: { fixer: { prompt: "default" } } });

	const missing = loadActiveTeamConfig({ cwd: join(missingRoot, "app"), globalConfigPath: null });
	const stale = loadActiveTeamConfig({ cwd: join(staleRoot, "app"), globalConfigPath: null });

	assert.deepEqual(missing.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: missingPath,
		parseStatus: "valid",
		scaffoldVersion: undefined,
		scaffoldVersionMissing: true,
		scaffoldStale: false,
		rawSchemaVersion: 4,
	});
	assert.deepEqual(stale.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: stalePath,
		parseStatus: "valid",
		scaffoldVersion: 0,
		scaffoldVersionMissing: false,
		scaffoldStale: true,
		rawSchemaVersion: 4,
	});
});

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
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
			fixer: {
				access: {
					write: true,
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
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
		}),
	);
	const nestedPath = writeProjectConfig(
		nestedRoot,
		buildConfig({
			reviewer: {
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

test("loadActiveTeamConfig accepts external role path scopes by default", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-external-scope-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			fixer: {
				access: {
					tools: ["read", "bash", "edit", "write"],
					write: true,
					pathScope: {
						roots: ["../external-logs", "src"],
						allowReadOutsideRoots: false,
						allowWrite: true,
					},
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.config.safety.allowWorkerPathsOutsideProject, true);
	const fixer = result.config.profiles.find((profile) => profile.name === "fixer");
	assert.deepEqual(fixer?.pathScope?.roots, [resolve(root, "../external-logs"), resolve(root, "src")]);
	assert.equal(fixer?.pathScope?.allowWrite, true);
});

test("loadActiveTeamConfig rejects external role path scopes when workerAccess opts out", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-external-scope-restricted-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		workerAccess: {
			allowPathsOutsideProject: false,
		},
		roles: {
			fixer: {
				access: {
					tools: ["read", "bash", "edit", "write"],
					write: true,
					pathScope: {
						roots: ["../external-logs"],
						allowReadOutsideRoots: false,
						allowWrite: true,
					},
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.equal(result.config.safety.allowWorkerPathsOutsideProject, true, "invalid config falls back to base defaults");
	assert.ok(result.diagnostics.some((diagnostic) => /within the project root/.test(diagnostic.message)));
});

test("loadActiveTeamConfig v4: user role declarations are source-of-truth (no ceiling comparisons)", () => {
	// In schema v4 the user's JSON owns the role list. There's no concept of a
	// built-in "ceiling" to compare against — role names are free-form and tools
	// are whatever the user declared. Platform-level safety (extensionMode
	// "inherit" block, pathScope required for writes) is still enforced at
	// delegate time via launch-policy, not here in the loader.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v4-freeform-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: {
				access: {
					tools: ["read", "edit", "bash", "grep", "find"],
					write: true,
				},
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
	// No narrowing diagnostics emitted under v4
	assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.code === "tools_broaden_forbidden"));
});

test("loadActiveTeamConfig v4: extensionMode 'inherit' in role access block is rejected (platform safety)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v4-recursion-block-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: {
				access: {
					tools: ["read", "grep"],
					write: false,
					extensionMode: "inherit",
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "extension_mode_inherit_forbidden"));
});

test("loadActiveTeamConfig v4: recursive self-extension sources are rejected", () => {
	const sources = [
		"pi-agents-team",
		"npm:pi-agents-team",
		"git:github.com/KristjanPikhof/pi-agents-team.git",
		"git+https://github.com/KristjanPikhof/pi-agents-team.git",
		"https://github.com/KristjanPikhof/pi-agents-team",
		"git@github.com:KristjanPikhof/pi-agents-team.git",
		"./extensions",
		"extensions",
		"./extensions/pi-agent-team",
		"./extensions/index.ts",
		"extensions/index.ts",
		"./extensions/pi-agent-team/index.ts",
		resolve(process.cwd(), "extensions/index.ts"),
		resolve(process.cwd(), "extensions/pi-agent-team/index.ts"),
		resolve(process.cwd(), "dist/extensions/index.js"),
		resolve(process.cwd(), "dist/extensions/pi-agent-team/index.js"),
		resolve(process.cwd(), "dist/extensions/../extensions/index.js"),
	];

	for (const source of sources) {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-team-self-extension-"));
		mkdirSync(join(root, "app"), { recursive: true });
		linkSelfExtensionEntrypoint(root, source);
		writeProjectConfig(root, {
			schemaVersion: 4,
			roles: {
				reviewer: {
					access: {
						extensions: [source],
					},
				} as any,
			},
		});

		const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
		assert.equal(result.status, "invalid", source);
		assert.equal(result.delegationEnabled, false, source);
		assert.ok(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "recursive_orchestrator_extension_forbidden" &&
					diagnostic.fieldPath === "roles.reviewer.access.extensions[0]" &&
					diagnostic.message.includes(source),
			),
			source,
		);
	}
});

test("loadActiveTeamConfig accepts a partial roles map (no required role keys)", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-partial-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { schemaVersion: 4, roles: { fixer: { prompt: "default" } } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.enabled, true);
});

test("loadActiveTeamConfig resolves enabled flag by precedence (project over global)", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-enabled-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, { schemaVersion: 4, enabled: true });

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, JSON.stringify({ schemaVersion: 4, enabled: false }));

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
	writeFileSync(globalPath, JSON.stringify({ schemaVersion: 4, enabled: false }));

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

test("loadActiveTeamConfig v4: project file fully replaces global — no cross-layer merging", () => {
	// In schema v4 the winning layer owns the role list outright. If a project
	// file is present, global is ignored entirely. This is a deliberate change
	// from earlier layered-narrowing semantics — roles are too free-form for
	// cross-layer merging to be meaningful.
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-replace-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	writeProjectConfig(projectRoot, {
		schemaVersion: 4,
		roles: {
			oracle: { thinkingLevel: "medium" } as any,
			worker: { access: { tools: ["read", "bash"], write: false } } as any,
		},
	});

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-replace-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(
		globalPath,
		JSON.stringify({
			schemaVersion: 4,
			roles: {
				oracle: { model: "openai/gpt-5.4", thinkingLevel: "high" },
				globalOnlyRole: { access: { tools: ["read"], write: false } },
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

test("loadActiveTeamConfig accepts the schema v4 role shape", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-flat-shape-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		defaultsVersion: 2,
		roles: {
			reviewer: {
				whenToUse: "custom",
				model: "default",
				thinkingLevel: "high",
				access: {
					tools: ["read", "grep", "find", "ls"],
					write: false,
				},
				prompt: "default",
			} as any,
			// access.write:true should translate to writePolicy scoped-write
			fixer: {
				access: {
					tools: ["read", "bash", "edit", "write"],
					write: true,
				},
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

test("loadActiveTeamConfig v4: access.extensions are normalized onto profiles", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-role-extensions-"));
	mkdirSync(join(root, "app"), { recursive: true });
	const absoluteExtension = join(root, "absolute-provider.ts");
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			explorer: {
				whenToUse: "Use for custom model provider discovery.",
				model: "myAnthropic/claude-opus-4-7",
				thinkingLevel: "low",
				access: {
					tools: ["read", "grep", "find", "ls", "bash"],
					write: false,
					extensions: [
						"./extensions/custom-provider.ts",
						"extensions/nodot-provider.ts",
						"npm:@org/pi-provider",
						"git:github.com/org/pi-provider@v1",
						"@org/package-provider",
						"pi-agents-team-provider",
						"npm:pi-agents-team-provider",
						absoluteExtension,
					],
				},
				prompt: "default",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	const explorer = result.config.profiles.find((profile) => profile.name === "explorer");
	assert.ok(explorer);
	assert.deepEqual(explorer?.extensions, [
		join(root, "extensions", "custom-provider.ts"),
		join(root, "extensions", "nodot-provider.ts"),
		"npm:@org/pi-provider",
		"git:github.com/org/pi-provider@v1",
		"@org/package-provider",
		"pi-agents-team-provider",
		"npm:pi-agents-team-provider",
		absoluteExtension,
	]);
});

test("loadActiveTeamConfig v4: empty extension sources invalidate the winning config", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-empty-extension-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			fixer: {
				access: {
					tools: ["read", "bash", "edit", "write"],
					write: true,
					extensions: ["./extensions/provider.ts", "  "],
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "extension_source_empty"));
});

test("loadActiveTeamConfig v4: non-string extension sources fail schema validation", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-non-string-extension-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			fixer: {
				access: {
					extensions: ["./extensions/provider.ts", 42],
				},
			} as any,
		},
	} as any);

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(
		result.diagnostics.some((diagnostic) => diagnostic.fieldPath?.includes("/roles/fixer/access/extensions/1") && /must be string/.test(diagnostic.message)),
		"expected a schema diagnostic for the non-string extension entry",
	);
});

test("loadActiveTeamConfig v4: extensionMode disable rejects explicit extensions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-disable-extension-conflict-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: {
				access: {
					extensionMode: "disable",
					extensions: ["npm:@org/pi-provider"],
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "extension_mode_disable_extensions_forbidden"));
});

test("loadActiveTeamConfig strips invalid role thinkingLevel and records a warning", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-thinking-typo-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			oracle: { thinkingLevel: "xhigh" } as any,
			reviewer: { thinkingLevel: "hihg", prompt: "default" } as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.deepEqual(result.thinkingLevelWarnings, [
		{ scope: "project", profileName: "reviewer", badValue: "hihg" },
	]);

	const oracle = result.config.profiles.find((profile) => profile.name === "oracle");
	assert.equal(oracle?.thinkingLevel, "xhigh", "valid roles in the same config must keep their thinking level");
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.thinkingLevel, undefined, "invalid thinkingLevel is stripped from only that role");
});

test("loadActiveTeamConfig accepts max thinkingLevel without warning", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-thinking-max-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			oracle: { thinkingLevel: "max", prompt: "default" },
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.deepEqual(result.thinkingLevelWarnings, []);
	const oracle = result.config.profiles.find((profile) => profile.name === "oracle");
	assert.equal(oracle?.thinkingLevel, "max");
});

test("loadActiveTeamConfig retains valid role thinkingLevel", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-thinking-valid-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: { thinkingLevel: "high", prompt: "default" } as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.deepEqual(result.thinkingLevelWarnings, []);
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.thinkingLevel, "high");
});

test("loadActiveTeamConfig leaves omitted role thinkingLevel undefined", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-thinking-absent-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: { prompt: "default" } as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.thinkingLevel, undefined);
});

test("loadActiveTeamConfig accepts xhigh thinkingLevel", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-thinking-xhigh-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			oracle: { thinkingLevel: "xhigh", prompt: "default" } as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	assert.deepEqual(result.thinkingLevelWarnings, []);
	const oracle = result.config.profiles.find((profile) => profile.name === "oracle");
	assert.equal(oracle?.thinkingLevel, "xhigh");
});

test("loadActiveTeamConfig v4: a string prompt that doesn't resolve to a file is stored as inline text", () => {
	// User writes `"prompt": "You are a specialized agent..."` directly in JSON.
	// Since no file matches that string, the loader treats it as inline prompt
	// text and surfaces it via promptInline. This is the user's escape hatch for
	// per-repo role prompts without having to create a .md file.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-inline-prompt-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"custom-scout": {
				whenToUse: "Fast repo recon.",
				access: {
					tools: ["read", "grep", "find", "ls"],
					write: false,
				},
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

test("loadActiveTeamConfig v4: custom role name with prompt 'default' uses the generic-worker sentinel", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-custom-default-prompt-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"custom-name": {
				whenToUse: "A totally custom worker.",
				access: {
					tools: ["read"],
					write: false,
				},
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

test("loadActiveTeamConfig v4: project file with schema mismatch does NOT let global take over (precedence by presence)", () => {
	// Finding-1 guarantee: a stale local project config must not silently
	// resurface broader global roles. Project wins by presence. If project is
	// mismatched, the loader falls back to built-in defaults, never to global.
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-finding1-project-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	// Write a project file with an obsolete schemaVersion (v3 instead of current v4).
	const projectPath = projectConfigPath(projectRoot);
	mkdirSync(resolve(projectPath, ".."), { recursive: true });
	writeFileSync(
		projectPath,
		JSON.stringify({
			schemaVersion: 3,
			roles: { "project-only": { prompt: "default" } },
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
			schemaVersion: 4,
			roles: {
				"global-only-writer": { access: { tools: ["read", "edit", "write"], write: true } },
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

test("loadActiveTeamConfig v4: whenToUse becomes the role description", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-whentouse-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			scout: {
				whenToUse: "Use when the user wants a fast API route map.",
				access: {
					tools: ["read", "grep"],
					write: false,
				},
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const scout = result.config.profiles.find((p) => p.name === "scout");
	assert.equal(scout?.description, "Use when the user wants a fast API route map.");
});

test("loadActiveTeamConfig v4: schema version mismatch warns and falls back to built-in", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-v1-file-"));
	mkdirSync(join(root, "app"), { recursive: true });
	// Write a file with schema version 1 — obsolete under v4.
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

test("loadActiveTeamConfig: fatal-parse on non-winning layer does NOT disable the winning layer", () => {
	// cr-expert P0: a broken global config used to set anyFatal=true and
	// short-circuit status to "invalid" machine-wide. That contradicted the
	// stated "project wins by presence" invariant — any typo in ~/.pi/agent/
	// disabled delegation in every repo. Now only the WINNING layer's fatal
	// parse propagates to status:"invalid"; a non-winning fatal becomes a
	// diagnostic and the winning layer still loads.
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-fatal-nonwinner-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	const projectPath = writeProjectConfig(projectRoot, {
		schemaVersion: 4,
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		roles: { "custom-scout": { access: { tools: ["read"], write: false } } as any },
	});

	const globalRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-fatal-nonwinner-global-"));
	mkdirSync(join(globalRoot, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	const globalPath = join(globalRoot, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	writeFileSync(globalPath, "{not json");

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: globalPath });
	assert.equal(result.status, "project", "project wins by presence even when global is fatal");
	assert.equal(result.delegationEnabled, true, "delegation stays enabled when the winning layer is valid");
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "project_config_parse_failed"));
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: projectPath,
		parseStatus: "valid",
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		scaffoldVersionMissing: false,
		scaffoldStale: false,
		rawSchemaVersion: 4,
	});
	assert.ok(result.config.profiles.find((profile) => profile.name === "custom-scout"));
});

test("loadActiveTeamConfig: fatal-parse on the winning layer still disables delegation", () => {
	// Complement to the test above: if the winning layer itself fails to
	// parse, status:"invalid" is the correct response (user's intended config
	// is broken; surface a clear diagnostic instead of silently falling back).
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-agent-team-fatal-winner-"));
	mkdirSync(join(projectRoot, "app"), { recursive: true });
	const projectPath = projectConfigPath(projectRoot);
	mkdirSync(resolve(projectPath, ".."), { recursive: true });
	writeFileSync(projectPath, "{not json — project file broken");

	const result = loadActiveTeamConfig({ cwd: join(projectRoot, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.deepEqual(result.activeConfigFreshness, {
		kind: "layer",
		scope: "project",
		path: projectPath,
		parseStatus: "fatal",
		scaffoldVersion: undefined,
		scaffoldVersionMissing: true,
		scaffoldStale: false,
		rawSchemaVersion: undefined,
	});
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "project_config_parse_failed"));
});

test("loadActiveTeamConfig defaults safety.projectRoot to cwd when no project config exists", () => {
	// Without a project config, safety.projectRoot still has to be concrete so
	// prompt-file containment and explicit workerAccess restrictions have a root
	// to compare against. Outside-project worker path scopes remain allowed by
	// default.
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-projectroot-default-"));
	const result = loadActiveTeamConfig({ cwd, globalConfigPath: null });
	assert.equal(result.status, "builtin");
	assert.equal(result.config.safety.allowWorkerPathsOutsideProject, true);
	assert.equal(result.config.safety.projectRoot, cwd);
});

test("loadActiveTeamConfig: missing path-shaped prompt disables delegation", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-prompt-typo-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"typo-role": {
				access: {
					tools: ["read"],
					write: false,
				},
				prompt: "./prompts/reviewr.md",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	const diagnostic = result.diagnostics.find((entry) => entry.code === "project_prompt_missing");
	assert.equal(diagnostic?.severity, "error");
	assert.ok(!result.config.profiles.find((profile) => profile.name === "typo-role"));
});

test("loadActiveTeamConfig: prompt directory disables delegation", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-prompt-directory-"));
	mkdirSync(join(root, "app"), { recursive: true });
	mkdirSync(join(root, "prompts"));
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"directory-role": {
				access: {
					tools: ["read"],
					write: false,
				},
				prompt: "./prompts",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	const diagnostic = result.diagnostics.find((entry) => entry.code === "project_prompt_not_a_file");
	assert.equal(diagnostic?.severity, "error");
});

test("loadActiveTeamConfig: project prompt survives a sibling worker cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-project-prompt-"));
	const workerCwd = mkdtempSync(join(tmpdir(), "pi-agent-team-worker-cwd-"));
	mkdirSync(join(root, "app"), { recursive: true });
	const promptPath = join(root, "prompts", "custom-reviewer.md");
	mkdirSync(resolve(promptPath, ".."), { recursive: true });
	writeFileSync(promptPath, "Review the project prompt contract.\n");
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"custom-reviewer": {
				access: {
					tools: ["read"],
					write: false,
				},
				prompt: "./prompts/custom-reviewer.md",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const profile = result.config.profiles.find((entry) => entry.name === "custom-reviewer");
	assert.ok(profile);
	assert.equal(profile.promptPath, promptPath);
	const plan = applyLaunchPolicy({ cwd: workerCwd, profile }, result.config);
	assert.equal(plan.systemPromptPath, promptPath);
	assert.equal(plan.systemPromptPath.startsWith(workerCwd), false);
	assert.equal(loadWorkerPrompt(profile.name, result.config), "Review the project prompt contract.");
});

test("loadActiveTeamConfig: empty prompt string resolves without crashing on EISDIR", () => {
	// cr-expert P2-11 companion: `"prompt": ""` used to pass through the path
	// resolver to `resolve(layerRoot, "")` which returns the layer root itself
	// (a directory). readFileSync would then crash with EISDIR at worker launch.
	// Now the empty-string guard fires first and we fall through to the generic
	// worker template with a clear diagnostic.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-prompt-empty-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"empty-prompt-role": {
				access: {
					tools: ["read"],
					write: false,
				},
				prompt: "",
			} as any,
		},
	});

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.status, "project");
	const role = result.config.profiles.find((profile) => profile.name === "empty-prompt-role");
	assert.equal(role?.promptPath, "<generic-worker>");
	assert.equal(role?.promptInline, undefined);
});
