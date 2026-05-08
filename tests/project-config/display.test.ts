import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE, type TeamProjectConfigFile } from "../../src/types";
import { loadActiveTeamConfig } from "../../src/project-config/loader";

function projectConfigPath(root: string): string {
	return join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

function writeProjectConfig(root: string, config: Partial<TeamProjectConfigFile> & { schemaVersion: 4 }): string {
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

test("display.cost: missing display block → displayCost defaults to true", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-display-missing-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { schemaVersion: 4 });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.displayCost, true, "missing display block must default displayCost to true");
});

test("display.cost: display.cost omitted inside display block → displayCost defaults to true", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-display-cost-omitted-"));
	mkdirSync(join(root, "app"), { recursive: true });
	// Write a display block with no cost field.
	const configPath = projectConfigPath(root);
	mkdirSync(resolve(configPath, ".."), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ schemaVersion: 4, display: {} }, null, 2));

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.displayCost, true, "omitted cost inside display must default to true");
});

test("display.cost: display.cost: false → displayCost resolves false", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-display-cost-false-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { schemaVersion: 4, display: { cost: false } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.displayCost, false, "display.cost: false must propagate to displayCost");
});

test("display.cost: display.cost: true → displayCost resolves true", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-display-cost-true-"));
	mkdirSync(join(root, "app"), { recursive: true });
	writeProjectConfig(root, { schemaVersion: 4, display: { cost: true } });

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.equal(result.displayCost, true, "display.cost: true must propagate to displayCost");
});

test("display.cost: old config without display block parses fine (additive non-breaking)", () => {
	// Simulate a config that was written before the display field existed.
	// It must load without schema rejection and displayCost must default to true.
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-display-old-config-"));
	mkdirSync(join(root, "app"), { recursive: true });
	// Minimal valid v4 file — no display field at all.
	writeFileSync(
		projectConfigPath(root),
		JSON.stringify({ schemaVersion: 4, enabled: true }, null, 2),
	);

	const result = loadActiveTeamConfig({ cwd: join(root, "app"), globalConfigPath: null });
	assert.ok(result.status !== "invalid", `expected non-invalid status, got ${result.status}`);
	assert.equal(result.displayCost, true, "old config without display block must not break loading");
	assert.ok(
		!result.diagnostics.some((d) => d.severity === "error"),
		`expected no errors for old config, got: ${result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`,
	);
});

test("display.cost: builtin status (no project file) → displayCost defaults to true", () => {
	// When there is no project config at all, the loader returns builtin status.
	// displayCost must still be true (winning layer is undefined, ?? true fires).
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-display-builtin-"));
	const result = loadActiveTeamConfig({ cwd, globalConfigPath: null });
	assert.equal(result.status, "builtin");
	assert.equal(result.displayCost, true, "builtin (no config) must produce displayCost: true");
});
