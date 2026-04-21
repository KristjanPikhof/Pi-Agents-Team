import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTeamToggleCommands } from "../../src/commands/team-toggle";
import { TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE } from "../../src/types";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installToggleCommands(emit: (text: string) => void, notify: (message: string, level?: string) => void, cwd: string) {
	const commands: RegisteredCommand[] = [];
	registerTeamToggleCommands(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{ emitText: (_ctx, text) => emit(text) },
	);
	const enable = commands.find((command) => command.name === "team-enable");
	const disable = commands.find((command) => command.name === "team-disable");
	assert.ok(enable);
	assert.ok(disable);
	return {
		enable: (args: string) => enable!.handler(args, { cwd, ui: { notify } } as any),
		disable: (args: string) => disable!.handler(args, { cwd, ui: { notify } } as any),
	};
}

test("/team-disable local creates a minimal file and flips enabled=false", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-disable-"));
	const emitted: string[] = [];
	const { disable } = installToggleCommands((text) => emitted.push(text), () => {}, root);

	await disable("local");

	const configPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	assert.ok(existsSync(configPath));
	const parsed = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(parsed.enabled, false);
	assert.ok(emitted[0]?.includes("enabled=default → false"));
	assert.ok(emitted[0]?.includes("/reload-plugins"));
});

test("/team-enable local preserves existing roles and sets enabled=true", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-enable-"));
	const configPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			version: 1,
			enabled: false,
			roles: {
				fixer: { permissions: {}, prompt: { source: "builtin" } },
			},
		}),
	);

	const emitted: string[] = [];
	const { enable } = installToggleCommands((text) => emitted.push(text), () => {}, root);
	await enable("local");

	const parsed = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(parsed.enabled, true);
	assert.deepEqual(parsed.roles.fixer, { permissions: {}, prompt: { source: "builtin" } });
	assert.ok(emitted[0]?.includes("enabled=false → true"));
});

test("/team-disable rewrites a broken JSON file with a warning", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-toggle-broken-"));
	const configPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	writeFileSync(configPath, "{not json");

	const emitted: string[] = [];
	const { disable } = installToggleCommands((text) => emitted.push(text), () => {}, root);
	await disable("local");

	const parsed = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(parsed.enabled, false);
	assert.ok(emitted[0]?.match(/not valid JSON|failed schema validation/));
});

test("/team-enable requires a scope argument", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-toggle-noscope-"));
	const emitted: string[] = [];
	const notifications: Array<{ message: string }> = [];
	const { enable } = installToggleCommands(
		(text) => emitted.push(text),
		(message) => notifications.push({ message }),
		root,
	);
	await enable("");
	assert.equal(emitted.length, 0);
	assert.match(notifications[0]?.message ?? "", /Usage: \/team-enable/);
});
