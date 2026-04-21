import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../extensions/pi-agent-team/index";
import { TEAM_PROFILE_NAMES, type TeamProjectConfigFile } from "../../src/types";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<unknown>;
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
		version: 1,
		roles: {
			...roles,
			...overrides,
		},
	};
}

test("invalid project config warns on session start and blocks delegate_task", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
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
