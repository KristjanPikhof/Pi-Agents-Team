import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
	assert.ok(emitted[0]?.includes("/reload"));
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

test("/team-disable backs up an unparsable file before writing a minimal replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-toggle-broken-"));
	const configDir = join(root, TEAM_PROJECT_CONFIG_DIR);
	const configPath = join(configDir, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(configDir, { recursive: true });
	const originalContents = "{not json — maybe the user had valuable roles here";
	writeFileSync(configPath, originalContents);

	const emitted: string[] = [];
	const { disable } = installToggleCommands((text) => emitted.push(text), () => {}, root);
	await disable("local");

	const parsed = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(parsed.enabled, false);
	assert.equal(parsed.schemaVersion, 3);

	// Finding-2 guarantee: toggle must never destroy operator content. The
	// unparsable original should be backed up to a timestamped sibling.
	const siblings = readdirSync(configDir);
	const backup = siblings.find((name) => name !== TEAM_PROJECT_CONFIG_FILE && name.endsWith(TEAM_PROJECT_CONFIG_FILE));
	assert.ok(backup, `expected a timestamped backup alongside ${TEAM_PROJECT_CONFIG_FILE}, saw: ${siblings.join(", ")}`);
	assert.match(backup!, /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?-agents-team\.json$/);
	assert.equal(readFileSync(join(configDir, backup!), "utf8"), originalContents);
	assert.ok(emitted[0]?.match(/unparsable/i));
	assert.ok(emitted[0]?.includes(backup!));
});

test("/team-disable preserves schema-drifted content and only patches enabled", async () => {
	// Finding-2 guarantee: when a file parses as JSON but drifts from the
	// current schema (e.g. old `version` field, custom fields, future fields),
	// the toggle preserves the user's object verbatim and only flips enabled.
	// No destruction, no silent "upgrade".
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-toggle-drift-"));
	const configDir = join(root, TEAM_PROJECT_CONFIG_DIR);
	const configPath = join(configDir, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(configDir, { recursive: true });
	// Simulate a future/hand-edited file with unknown top-level fields.
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 3,
			enabled: true,
			roles: { custom: { tools: ["read"], write: false } },
			futureField: { nested: "value" },
		}),
	);

	const emitted: string[] = [];
	const { disable } = installToggleCommands((text) => emitted.push(text), () => {}, root);
	await disable("local");

	const parsed = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal(parsed.enabled, false, "enabled should flip");
	assert.deepEqual(parsed.roles, { custom: { tools: ["read"], write: false } }, "user roles must survive");
	// The futureField is preserved since the file was handled as schema-drift (additionalProperties rejects it, triggering the drift branch).
	assert.deepEqual(parsed.futureField, { nested: "value" }, "unknown fields must not be stripped");
	// Siblings should NOT include a backup — preservation is silent, no backup needed.
	const siblings = readdirSync(configDir);
	const backup = siblings.find((name) => name !== TEAM_PROJECT_CONFIG_FILE && name.endsWith(TEAM_PROJECT_CONFIG_FILE));
	assert.equal(backup, undefined, "schema-drift path must NOT back up (content is preserved in place)");
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
