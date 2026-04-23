import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTeamInitCommand, _testing } from "../../src/commands/team-init";
import { CURRENT_SCAFFOLD_VERSION, DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	DEFAULT_MODEL_SENTINEL,
	DEFAULT_PROMPT_SENTINEL,
	TEAM_PROJECT_CONFIG_DIR,
	TEAM_PROJECT_CONFIG_FILE,
} from "../../src/types";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installInitCommand(emit: (text: string) => void, notify: (message: string, level?: string) => void, cwd: string) {
	const commands: RegisteredCommand[] = [];
	registerTeamInitCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{ emitText: (_ctx, text) => emit(text) },
	);
	const init = commands.find((command) => command.name === "team-init");
	assert.ok(init);
	return {
		run: (args: string) => init!.handler(args, { cwd, ui: { notify } } as any),
	};
}

test("parseInitArgs accepts scope and force flag", () => {
	assert.deepEqual(_testing.parseInitArgs("local"), { scope: "local", force: false });
	assert.deepEqual(_testing.parseInitArgs("global --force"), { scope: "global", force: true });
	assert.deepEqual(_testing.parseInitArgs("-f local"), { scope: "local", force: true });
	const missing = _testing.parseInitArgs("");
	assert.equal(missing.scope, undefined);
	const unknown = _testing.parseInitArgs("bogus");
	assert.match(unknown.error ?? "", /Unknown argument/);
	const twice = _testing.parseInitArgs("local global");
	assert.match(twice.error ?? "", /only once/);
});

test("buildFullScaffold pre-populates every builtin profile in the schema v4 shape", () => {
	const scaffold = _testing.buildFullScaffold();
	assert.equal(scaffold.schemaVersion, 4);
	assert.equal(scaffold.scaffoldVersion, CURRENT_SCAFFOLD_VERSION);
	assert.equal(scaffold.enabled, true);
	assert.equal(scaffold.workerAccess?.allowPathsOutsideProject, false);
	const roles = scaffold.roles ?? {};
	for (const profile of DEFAULT_TEAM_CONFIG.profiles) {
		const role = (roles as Record<string, unknown>)[profile.name] as any;
		assert.ok(role, `missing scaffold role for ${profile.name}`);
		assert.equal(role.thinkingLevel, profile.thinkingLevel);
		assert.deepEqual(role.access.tools, profile.tools);
		assert.equal(role.access.write, profile.writePolicy === "scoped-write");
		assert.equal(role.model, DEFAULT_MODEL_SENTINEL);
		assert.equal(role.prompt, DEFAULT_PROMPT_SENTINEL);
		assert.equal(role.whenToUse, profile.description, "scaffold should emit whenToUse with the role's trigger description");
		assert.equal(role.description, undefined, "scaffold must not emit the legacy description alias");
		assert.equal(role.permissions, undefined, "flat shape must not emit the legacy permissions wrapper");
		assert.equal(role.tools, undefined, "tools must live under access");
		assert.equal(role.write, undefined, "write must live under access");
		assert.equal(role.advanced, undefined, "advanced must not be emitted in schema v4");
		assert.match(role.whenToUse, /^Use (for|when|to) /, "default whenToUse should read as a trigger sentence starting with 'Use for/when/to'");
	}
});

test("formatBackupTimestamp pads date components including seconds", () => {
	// Seconds are included in the timestamp so two concurrent /team-init runs
	// inside the same minute don't collide on the suffix loop. The trailing
	// "00" is the second-of-minute for new Date(..., 9, 7) (no second arg).
	assert.equal(_testing.formatBackupTimestamp(new Date(2026, 3, 5, 9, 7)), "2026-04-05-090700");
	assert.equal(_testing.formatBackupTimestamp(new Date(2026, 3, 5, 9, 7, 42)), "2026-04-05-090742");
});

test("/team-init local writes a full scaffold inside the project", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-init-local-"));
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const { run } = installInitCommand(
		(text) => emitted.push(text),
		(message, level) => notifications.push({ message, level }),
		root,
	);

	await run("local");

	const expectedPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	assert.ok(existsSync(expectedPath));
	const parsed = JSON.parse(readFileSync(expectedPath, "utf8"));
	assert.equal(parsed.schemaVersion, 4);
	assert.equal(parsed.scaffoldVersion, CURRENT_SCAFFOLD_VERSION);
	assert.equal(parsed.enabled, true);
	assert.equal(parsed.workerAccess.allowPathsOutsideProject, false);
	const roleNames = Object.keys(parsed.roles ?? {}).sort();
	assert.deepEqual(roleNames, DEFAULT_TEAM_CONFIG.profiles.map((profile) => profile.name).sort());
	assert.ok(emitted[0]?.includes(expectedPath));
	assert.ok(emitted[0]?.includes("/reload"));
});

test("/team-init refuses to overwrite without --force and mentions backup", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-init-guard-"));
	const targetPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	writeFileSync(targetPath, JSON.stringify({ version: 1, enabled: false, roles: { fixer: { permissions: {}, prompt: { source: "builtin" } } } }));

	const emitted: string[] = [];
	const { run } = installInitCommand((text) => emitted.push(text), () => {}, root);
	await run("local");

	const contents = JSON.parse(readFileSync(targetPath, "utf8"));
	assert.equal(contents.enabled, false);
	assert.ok(emitted[0]?.includes("already exists"));
	assert.ok(emitted[0]?.includes("--force"));
	assert.ok(emitted[0]?.toLowerCase().includes("backed up"));
});

test("/team-init --force backs up the old file before overwriting", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-init-force-"));
	const targetPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	writeFileSync(targetPath, JSON.stringify({ version: 1, enabled: false }));

	const emitted: string[] = [];
	const { run } = installInitCommand((text) => emitted.push(text), () => {}, root);
	await run("local --force");

	const contents = JSON.parse(readFileSync(targetPath, "utf8"));
	assert.equal(contents.enabled, true);
	assert.equal(contents.scaffoldVersion, CURRENT_SCAFFOLD_VERSION);
	assert.ok(contents.roles && Object.keys(contents.roles).length === DEFAULT_TEAM_CONFIG.profiles.length);

	const siblings = readdirSync(join(root, TEAM_PROJECT_CONFIG_DIR));
	const backup = siblings.find((name) => name !== TEAM_PROJECT_CONFIG_FILE && name.endsWith(TEAM_PROJECT_CONFIG_FILE));
	assert.ok(backup, `expected a backup file alongside ${TEAM_PROJECT_CONFIG_FILE}, saw: ${siblings.join(", ")}`);
	assert.match(backup!, /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?-agents-team\.json$/);
	const backupContents = JSON.parse(readFileSync(join(root, TEAM_PROJECT_CONFIG_DIR, backup!), "utf8"));
	assert.equal(backupContents.enabled, false);
	assert.ok(emitted[0]?.includes("Backed up previous config"));
});

test("/team-init requires an explicit scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-init-noscope-"));
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const { run } = installInitCommand(
		(text) => emitted.push(text),
		(message, level) => notifications.push({ message, level }),
		root,
	);
	await run("");
	assert.equal(emitted.length, 0);
	assert.match(notifications[0]?.message ?? "", /Usage: \/team-init/);
});
