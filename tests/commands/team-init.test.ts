import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTeamInitCommand, _testing } from "../../src/commands/team-init";
import { TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE } from "../../src/types";

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

test("/team-init local writes a skeleton inside the project", async () => {
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
	assert.equal(parsed.version, 1);
	assert.equal(parsed.enabled, true);
	assert.deepEqual(parsed.roles, {});
	assert.ok(emitted[0]?.includes(expectedPath));
	assert.ok(emitted[0]?.includes("/reload-plugins"));
});

test("/team-init refuses to overwrite without --force", async () => {
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
});

test("/team-init --force overwrites an existing file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-init-force-"));
	const targetPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
	mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
	writeFileSync(targetPath, JSON.stringify({ version: 1, enabled: false }));

	const emitted: string[] = [];
	const { run } = installInitCommand((text) => emitted.push(text), () => {}, root);
	await run("local --force");

	const contents = JSON.parse(readFileSync(targetPath, "utf8"));
	assert.equal(contents.enabled, true);
	assert.deepEqual(contents.roles, {});
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
