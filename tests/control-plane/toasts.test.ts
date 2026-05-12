import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { _testing } from "../../extensions/pi-agent-team/index";
import { THINKING_LEVELS, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE } from "../../src/types";

process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = "none";

function writeProjectConfig(root: string, config: Record<string, unknown>): void {
	const configDir = join(root, TEAM_PROJECT_CONFIG_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, TEAM_PROJECT_CONFIG_FILE), JSON.stringify(config, null, 2));
}

test("thinkingLevel warning toast lists valid values and keys by scope/profile/bad value", () => {
	const warning = { scope: "project" as const, profileName: "reviewer", badValue: "turbo" };

	assert.equal(_testing.thinkingLevelWarningToastKey(warning), "project\0reviewer\0turbo");
	assert.equal(
		_testing.buildThinkingLevelWarningToast(warning),
		`Pi Agents Team: local agents-team.json role "reviewer" has invalid thinkingLevel "turbo"; field dropped and default thinkingLevel will be used. Valid values: ${THINKING_LEVELS.join(", ")}.`,
	);
});

test("session_start emits each invalid thinkingLevel warning once per process", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-toasts-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			reviewer: { prompt: "default", thinkingLevel: "turbo" },
		},
	});

	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const notifications: string[] = [];

	extension({
		registerTool() {},
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
	await handlers.get("session_start")?.({ reason: "reload" }, ctx);

	const warningToasts = notifications.filter((message) => message.includes("invalid thinkingLevel \"turbo\""));
	assert.equal(warningToasts.length, 1);
});

test("thinking clamp toast includes worker, requested/effective values, model, and stable dedup key", () => {
	const event = {
		type: "thinking_clamped" as const,
		workerId: "w7",
		profileName: "fixer",
		modelLabel: "provider/model",
		requested: "high" as const,
		effective: "low" as const,
		timestamp: 123,
	};

	assert.equal(_testing.thinkingClampToastKey(event), "w7\0high\0low");
	assert.equal(
		_testing.buildThinkingClampToast(event),
		"Pi Agents Team: worker w7 (fixer) requested thinkingLevel high; Pi clamped to low for model provider/model because the model lacks support. Edit agents-team.json or change model.",
	);
	assert.equal(
		_testing.thinkingClampToastKey({ ...event, profileName: "reviewer", modelLabel: "other/model", timestamp: 456 }),
		"w7\0high\0low",
	);
});

test("orchestrator thinking level is read from the Pi API before legacy context fallback", () => {
	assert.equal(
		_testing.getOrchestratorThinkingLevel(
			{ getThinkingLevel: () => "high" } as any,
			{ getThinkingLevel: () => "low" } as any,
		),
		"high",
	);
	assert.equal(
		_testing.getOrchestratorThinkingLevel({} as any, { getThinkingLevel: () => "low" } as any),
		"low",
	);
});
