import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = "none";

import extension from "../../extensions/pi-agent-team/index";
import {
	TEAM_PROFILE_NAMES,
	TEAM_PROJECT_CONFIG_DIR,
	TEAM_PROJECT_CONFIG_FILE,
	type TeamProjectConfigFile,
} from "../../src/types";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<unknown>;
}

function projectConfigPath(root: string): string {
	return join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
}

function writeProjectConfig(root: string, config: TeamProjectConfigFile): void {
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
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

test("valid project config announces the session-frozen handoff and injects a prompt note", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-valid-"));
	const cwd = join(root, "app");
	mkdirSync(join(root, "prompts"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "prompts", "reviewer.md"), "# project reviewer override\n");
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				prompt: { source: "project", path: "prompts/reviewer.md" },
			},
		}),
	);

	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const notifications: string[] = [];

	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			setWidget() {},
			setTitle() {},
		},
		sessionManager: {
			getEntries() {
				return [];
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(notifications.some((message) => /loaded session-frozen project config/i.test(message)));

	const beforeStart = await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx) as { systemPrompt: string };
	assert.match(beforeStart.systemPrompt, /Session-frozen project role config loaded from/i);
	assert.ok(tools.find((tool) => tool.name === "delegate_task"));
});

test("invalid project config warns on session start and blocks delegate_task", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				prompt: { source: "project", path: "../outside.md" },
			},
		}),
	);

	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const notifications: string[] = [];

	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			setWidget() {},
			setTitle() {},
		},
		sessionManager: {
			getEntries() {
				return [];
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(notifications.some((message) => /invalid agents-team\.json — delegation disabled/i.test(message)));

	const beforeStart = await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx) as { systemPrompt: string };
	assert.match(beforeStart.systemPrompt, /Delegation is disabled until it is fixed/i);

	const delegateTask = tools.find((tool) => tool.name === "delegate_task");
	assert.ok(delegateTask);
	await assert.rejects(
		() => delegateTask!.execute("tool-1", {
			title: "Probe",
			goal: "Try to launch a worker",
			profileName: "reviewer",
		}, undefined, undefined, ctx),
		/delegation is disabled because agents-team\.json is invalid/i,
	);
});
