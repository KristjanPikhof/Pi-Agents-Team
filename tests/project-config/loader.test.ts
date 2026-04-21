import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_PROFILE_NAMES, type TeamProjectConfigFile } from "../../src/types";
import { loadActiveTeamConfig } from "../../src/project-config/loader";

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
		version: 1,
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
	writeFileSync(
		join(root, "agents-team.json"),
		JSON.stringify(
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
			null,
			2,
		),
	);

	const result = loadActiveTeamConfig({ cwd: nestedCwd });
	assert.equal(result.status, "project");
	assert.equal(result.delegationEnabled, true);
	assert.equal(result.sourcePath, join(root, "agents-team.json"));
	assert.equal(result.projectRoot, root);
	assert.match(result.diagnostics[0]?.message ?? "", /Loaded session-frozen project config/);

	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.equal(reviewer?.promptPath, join(root, "prompts", "reviewer.md"));

	const fixer = result.config.profiles.find((profile) => profile.name === "fixer");
	assert.deepEqual(fixer?.pathScope?.roots, [join(root, "src", "scoped")]);
	assert.equal(result.config.safety.allowProjectProfiles, true);
});

test("loadActiveTeamConfig disables delegation when project paths escape the discovered root", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-config-invalid-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeFileSync(
		join(root, "agents-team.json"),
		JSON.stringify(
			buildConfig({
				reviewer: {
					permissions: {},
					prompt: { source: "project", path: "../outside.md" },
				},
			}),
			null,
			2,
		),
	);

	const result = loadActiveTeamConfig({ cwd: join(root, "app") });
	assert.equal(result.status, "invalid");
	assert.equal(result.delegationEnabled, false);
	assert.match(result.diagnostics[0]?.message ?? "", /within the project root/);
	const reviewer = result.config.profiles.find((profile) => profile.name === "reviewer");
	assert.match(reviewer?.promptPath ?? "", /prompts\/agents\/reviewer\.md$/);
});
