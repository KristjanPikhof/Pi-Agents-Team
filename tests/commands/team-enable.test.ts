import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = "none";

import { DEFAULT_TEAM_CONFIG } from "../../src/config";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import {
	_testing as enableTesting,
	registerTeamEnableCommand,
} from "../../src/commands/team-enable";
import type { LoadedTeamProjectConfig } from "../../src/types";
import { TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport } from "../runtime/test-helpers";

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function buildLoadedConfig(overrides: Partial<LoadedTeamProjectConfig> = {}): LoadedTeamProjectConfig {
	return {
		status: "builtin",
		config: DEFAULT_TEAM_CONFIG,
		layers: [],
		enabled: true,
		enabledSource: "default",
		diagnostics: [],
		delegationEnabled: true,
		displayCost: true,
		...overrides,
	};
}

function installTeamEnableCommand(
	cwd: string,
	projectConfig: LoadedTeamProjectConfig,
	options: { ensureNotReloading?: () => void } = {},
) {
	const commands: RegisteredCommand[] = [];
	const teamManager = new TeamManager({
		workerManager: new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport())),
	});
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	registerTeamEnableCommand(
		{
			registerCommand(name: string, spec: RegisteredCommand) {
				commands.push({ name, handler: spec.handler });
			},
		} as any,
		{
			getTeamManager: () => teamManager,
			getProjectConfig: () => projectConfig,
			emitText: (_ctx, text) => emitted.push(text),
			ensureNotReloading: options.ensureNotReloading ?? (() => {}),
		},
	);
	const cmd = commands.find((c) => c.name === "team-enable");
	assert.ok(cmd, "team-enable command must register");
	const ctx = {
		cwd,
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
	} as any;
	return {
		run: (args: string) => cmd!.handler(args, ctx),
		emitted,
		notifications,
		teamManager,
	};
}

test("parseTeamEnableArgs accepts on/off, --local/--global, and deprecated --persist global|local", () => {
	assert.deepEqual(enableTesting.parseTeamEnableArgs("on"), { mode: "team", persist: undefined });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("off"), { mode: "solo", persist: undefined });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("on --global"), { mode: "team", persist: "global" });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("off --local"), { mode: "solo", persist: "local" });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("on --persist global"), { mode: "team", persist: "global", persistAliasDeprecated: true });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("--persist local off"), { mode: "solo", persist: "local", persistAliasDeprecated: true });

	const empty = enableTesting.parseTeamEnableArgs("");
	assert.match(empty.error ?? "", /Usage:/);

	const noMode = enableTesting.parseTeamEnableArgs("--persist local");
	assert.match(noMode.error ?? "", /Usage:/);

	const badPersist = enableTesting.parseTeamEnableArgs("on --persist nope");
	assert.match(badPersist.error ?? "", /--persist requires a scope/);

	const garbage = enableTesting.parseTeamEnableArgs("foo");
	assert.match(garbage.error ?? "", /Unknown argument/);
});

test("/team-enable on flips routingMode to team session-only without persistence by default", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-on-"));
	try {
		const harness = installTeamEnableCommand(root, buildLoadedConfig());
		harness.teamManager.setRoutingMode("solo");
		await harness.run("on");
		assert.equal(harness.teamManager.routingMode, "team");
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		assert.equal(existsSync(localPath), false, "no-flag toggle must not persist");
		assert.ok(harness.emitted[0]?.includes("solo → team"));
		assert.ok(harness.emitted[0]?.includes("Session-only change; resets on /reload or restart"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable off flips routingMode to solo and emits the solo guidance line", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-off-"));
	try {
		const harness = installTeamEnableCommand(root, buildLoadedConfig());
		await harness.run("off");
		assert.equal(harness.teamManager.routingMode, "solo");
		assert.ok(harness.emitted[0]?.includes("team → solo"));
		assert.ok(harness.emitted[0]?.includes("delegate_task is gated off"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable on --local writes routingMode to the local file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-persist-local-"));
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(
			localPath,
			JSON.stringify({
				schemaVersion: 4,
				routingMode: "solo",
				roles: { reviewer: { whenToUse: "Use for review", access: { tools: [] }, prompt: "<default>" } },
			}, null, 2),
		);
		const harness = installTeamEnableCommand(root, buildLoadedConfig({ sourcePath: localPath }));
		harness.teamManager.setRoutingMode("solo");
		await harness.run("on --local");
		assert.equal(harness.teamManager.routingMode, "team");
		const written = JSON.parse(readFileSync(localPath, "utf8"));
		assert.equal(written.routingMode, "team");
		assert.ok(written.roles?.reviewer, "roles must be preserved on explicit --persist patch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable off --persist local still works as a deprecated alias", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-persist-alias-"));
	try {
		const harness = installTeamEnableCommand(root, buildLoadedConfig());
		await harness.run("off --persist local");
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		const written = JSON.parse(readFileSync(localPath, "utf8"));
		assert.equal(written.routingMode, "solo");
		assert.ok(harness.emitted[0]?.includes("--persist is deprecated"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable off --global is honored and warns when a local config shadows it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-persist-global-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-team-enable-global-"));
	const globalPath = join(globalDir, TEAM_PROJECT_CONFIG_FILE);
	const previous = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
	process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = globalPath;
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(localPath, JSON.stringify({ schemaVersion: 4, routingMode: "team" }, null, 2));
		const harness = installTeamEnableCommand(root, buildLoadedConfig({ sourcePath: localPath }));
		await harness.run("off --global");
		const written = JSON.parse(readFileSync(globalPath, "utf8"));
		assert.equal(written.routingMode, "solo");
		const localWritten = JSON.parse(readFileSync(localPath, "utf8"));
		assert.equal(localWritten.routingMode, "team", "explicit --global must not patch local config");
		assert.ok(harness.emitted[0]?.includes("shadows this global routingMode"));
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		else process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("/team-enable --global does not warn that the target global file shadows itself", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-self-shadow-"));
	const previous = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
	try {
		const globalPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = globalPath;
		const harness = installTeamEnableCommand(root, buildLoadedConfig());
		await harness.run("off --global");
		assert.ok(harness.emitted[0]?.includes(`Persisted routingMode=solo to ${globalPath}`));
		assert.ok(!harness.emitted[0]?.includes("shadows this global routingMode"));
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		else process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable --global warns when an ancestor project config shadows it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-ancestor-shadow-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-team-enable-ancestor-global-"));
	const globalPath = join(globalDir, TEAM_PROJECT_CONFIG_FILE);
	const previous = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
	process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = globalPath;
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		const childCwd = join(root, "packages", "one");
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		mkdirSync(childCwd, { recursive: true });
		writeFileSync(localPath, JSON.stringify({ schemaVersion: 4, routingMode: "team" }, null, 2));
		const harness = installTeamEnableCommand(childCwd, buildLoadedConfig({ sourcePath: localPath }));
		await harness.run("off --global");
		const written = JSON.parse(readFileSync(globalPath, "utf8"));
		assert.equal(written.routingMode, "solo");
		assert.ok(harness.emitted[0]?.includes(localPath));
		assert.ok(harness.emitted[0]?.includes("shadows this global routingMode"));
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		else process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("/team-enable explicit persistence failure leaves live routing unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-persist-fail-"));
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(localPath, "{ broken json");
		const harness = installTeamEnableCommand(root, buildLoadedConfig({ sourcePath: localPath }));
		harness.teamManager.setRoutingMode("solo");
		await harness.run("on --local");
		assert.equal(harness.teamManager.routingMode, "solo", "failed persistence must not change live routing");
		assert.ok(harness.emitted[0]?.includes("Persistence failed"));
		assert.ok(harness.emitted[0]?.includes("Routing mode remains solo"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable on refuses when the project config has Pi Agents Team disabled", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-disabled-"));
	try {
		const harness = installTeamEnableCommand(root, buildLoadedConfig({ enabled: false }));
		await harness.run("on");
		assert.equal(harness.teamManager.routingMode, "team", "default mode unchanged");
		assert.equal(harness.emitted.length, 0, "no emit on refusal");
		assert.match(
			harness.notifications[0]?.message ?? "",
			/disabled — enable it by editing agents-team\.json/,
		);
		// Old hint pointed at /team-enable global; the refusal must NOT recommend
		// the now-removed slash-command form.
		assert.doesNotMatch(
			harness.notifications[0]?.message ?? "",
			/\/team-enable global/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable on does not auto-resolve persistence target from sourcePath winning layer", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-auto-resolve-"));
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(localPath, JSON.stringify({ schemaVersion: 4, routingMode: "solo" }, null, 2));
		const harness = installTeamEnableCommand(root, buildLoadedConfig({ sourcePath: localPath }));
		harness.teamManager.setRoutingMode("solo");
		await harness.run("on");
		assert.equal(harness.teamManager.routingMode, "team");
		const written = JSON.parse(readFileSync(localPath, "utf8"));
		assert.equal(written.routingMode, "solo", "no-flag toggle must not patch winning layer");
		assert.ok(harness.emitted[0]?.includes("Session-only change"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable rejects missing/invalid args via notify, leaves mode unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-bad-args-"));
	try {
		const harness = installTeamEnableCommand(root, buildLoadedConfig());
		await harness.run("");
		assert.match(harness.notifications[0]?.message ?? "", /Usage:/);
		await harness.run("foo");
		assert.match(harness.notifications[1]?.message ?? "", /Unknown argument/);
		await harness.run("on --persist sideways");
		assert.match(harness.notifications[2]?.message ?? "", /--persist requires a scope/);
		assert.equal(harness.emitted.length, 0);
		assert.equal(harness.teamManager.routingMode, "team");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable bails with notify when ensureNotReloading throws", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-team-enable-reload-"));
	try {
		const harness = installTeamEnableCommand(
			root,
			buildLoadedConfig(),
			{
				ensureNotReloading: () => {
					throw new Error("Pi Agents Team is reloading its project config — retry in a moment.");
				},
			},
		);
		// The reloading guard is also enforced inside runSetRoutingMode, so any
		// path that proceeds past parseArgs must surface the reloading message.
		harness.teamManager.setRoutingMode("solo");
		await harness.run("on");
		assert.equal(harness.teamManager.routingMode, "solo", "mode must NOT change while reloading");
		assert.equal(harness.emitted.length, 0);
		assert.match(harness.notifications[0]?.message ?? "", /reloading/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
