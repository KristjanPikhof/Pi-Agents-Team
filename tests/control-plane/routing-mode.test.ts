import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = "none";

import { loadActiveTeamConfig } from "../../src/project-config/loader";
import { TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE } from "../../src/types";
import { DEFAULT_TEAM_CONFIG, createDefaultTeamState } from "../../src/config";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { buildOrchestratorPromptBundle } from "../../src/prompts/contracts";
import { buildTeamStatusLine, buildTeamWidgetLines } from "../../src/ui/status-widget";
import { _testing as enableTesting, registerTeamEnableCommand } from "../../src/commands/team-enable";
import type { LoadedTeamProjectConfig } from "../../src/types";
import { MockWorkerHandle, MockWorkerTransport } from "../runtime/test-helpers";

test("TeamManager defaults routingMode to team and accepts an override", () => {
	const teamA = new TeamManager({ workerManager: new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport())) });
	assert.equal(teamA.routingMode, "team");

	const teamB = new TeamManager({
		workerManager: new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport())),
		routingMode: "solo",
	});
	assert.equal(teamB.routingMode, "solo");
});

test("setRoutingMode flips the mode and emits a state_change event", () => {
	const teamManager = new TeamManager({
		workerManager: new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport())),
	});

	let emissions = 0;
	const dispose = teamManager.onStateChange(() => {
		emissions += 1;
	});

	teamManager.setRoutingMode("solo");
	assert.equal(teamManager.routingMode, "solo");
	assert.equal(emissions, 1);

	teamManager.setRoutingMode("solo");
	assert.equal(emissions, 1, "no event when mode is unchanged");

	teamManager.setRoutingMode("team");
	assert.equal(teamManager.routingMode, "team");
	assert.equal(emissions, 2);

	dispose();
});

test("orchestrator prompt swaps the profile catalog for a solo directive when routingMode is solo", () => {
	const state = createDefaultTeamState();
	const teamBundle = buildOrchestratorPromptBundle(state, DEFAULT_TEAM_CONFIG, "team");
	assert.match(teamBundle, /Available worker profiles/);
	assert.doesNotMatch(teamBundle, /Routing mode: solo/);

	const soloBundle = buildOrchestratorPromptBundle(state, DEFAULT_TEAM_CONFIG, "solo");
	assert.match(soloBundle, /Routing mode: solo/);
	assert.match(soloBundle, /do not call `delegate_task`/);
	assert.doesNotMatch(soloBundle, /## Available worker profiles/);
});

test("widget collapses to a single solo badge line when routingMode is solo and workers are tracked", () => {
	const emptyState = createDefaultTeamState();
	const teamLinesEmpty = buildTeamWidgetLines(emptyState, { routingMode: "team" });
	assert.deepEqual(teamLinesEmpty, [], "team mode hides widget when no workers");

	const soloLinesEmpty = buildTeamWidgetLines(emptyState, { routingMode: "solo" });
	assert.deepEqual(soloLinesEmpty, [], "solo mode also hides widget when no workers — status line still shows the badge");

	const stateWithWorker = createDefaultTeamState();
	stateWithWorker.activeWorkers.w1 = {
		workerId: "w1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "running",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
	};
	const soloLinesWithWorker = buildTeamWidgetLines(stateWithWorker, { routingMode: "solo" });
	assert.equal(soloLinesWithWorker.length, 1);
	assert.match(soloLinesWithWorker[0]!, /Pi Agents Team — solo/);

	const soloStatus = buildTeamStatusLine(emptyState, "solo");
	assert.match(soloStatus, /Pi Agents Team — solo/);
});

test("parseTeamEnableArgs requires on|off and accepts --persist global|local", () => {
	assert.deepEqual(enableTesting.parseTeamEnableArgs("on"), { mode: "team", persist: undefined });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("off"), { mode: "solo", persist: undefined });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("on --persist global"), { mode: "team", persist: "global" });
	assert.deepEqual(enableTesting.parseTeamEnableArgs("off --persist local"), { mode: "solo", persist: "local" });

	const empty = enableTesting.parseTeamEnableArgs("");
	assert.match(empty.error ?? "", /Usage: \/team-enable/);

	const missingScope = enableTesting.parseTeamEnableArgs("on --persist");
	assert.match(missingScope.error ?? "", /--persist requires a scope/);

	const badScope = enableTesting.parseTeamEnableArgs("on --persist nope");
	assert.match(badScope.error ?? "", /--persist requires a scope/);

	const garbage = enableTesting.parseTeamEnableArgs("foo");
	assert.match(garbage.error ?? "", /Unknown argument/);

	const bothModes = enableTesting.parseTeamEnableArgs("on off");
	assert.match(bothModes.error ?? "", /only once/);
});

test("loadActiveTeamConfig surfaces persistedRoutingMode from the project file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-routing-load-"));
	try {
		const configDir = join(root, TEAM_PROJECT_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, TEAM_PROJECT_CONFIG_FILE),
			JSON.stringify({ schemaVersion: 4, routingMode: "solo" }, null, 2),
		);
		const loaded = loadActiveTeamConfig({ cwd: root });
		assert.equal(loaded.persistedRoutingMode, "solo");
		assert.equal(loaded.enabled, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadActiveTeamConfig does not leak global routingMode when the project file is schema-mismatched", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-routing-mismatch-"));
	try {
		const configDir = join(root, TEAM_PROJECT_CONFIG_DIR);
		mkdirSync(configDir, { recursive: true });
		// Project file present but uses an unsupported schemaVersion. By the
		// "project wins by presence, never downshift" rule the global layer's
		// routingMode must NOT bleed into this repo.
		writeFileSync(
			join(configDir, TEAM_PROJECT_CONFIG_FILE),
			JSON.stringify({ schemaVersion: 1 }, null, 2),
		);
		const loaded = loadActiveTeamConfig({ cwd: root });
		assert.equal(loaded.status, "builtin");
		assert.equal(loaded.persistedRoutingMode, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("persistRoutingMode writes routingMode atomically to a fresh project file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-routing-"));
	try {
		const result = enableTesting.persistRoutingMode("local", "solo", root);
		assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
		const written = JSON.parse(readFileSync((result as { path: string }).path, "utf8"));
		assert.equal(written.routingMode, "solo");
		assert.equal(typeof written.schemaVersion, "number");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deriveScopeFromSourcePath maps the local project file to local", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-derive-"));
	try {
		const localPath = join(cwd, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		assert.equal(enableTesting.deriveScopeFromSourcePath(localPath, cwd), "local");
		assert.equal(enableTesting.deriveScopeFromSourcePath("/tmp/somewhere-else.json", cwd), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function installEnableCommand(cwd: string, projectConfig: LoadedTeamProjectConfig) {
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
			ensureNotReloading: () => {},
		},
	);
	const teamEnable = commands.find((c) => c.name === "team-enable")!;
	const ctx = { cwd, ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } } as any;
	return {
		run: (args: string) => teamEnable.handler(args, ctx),
		emitted,
		notifications,
		teamManager,
	};
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
		...overrides,
	};
}

test("/team-enable off without --persist auto-creates a local stub when no config file exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-autopersist-stub-"));
	try {
		const harness = installEnableCommand(root, buildLoadedConfig());
		await harness.run("off");
		const expected = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		assert.ok(existsSync(expected), `expected stub at ${expected}`);
		const written = JSON.parse(readFileSync(expected, "utf8"));
		assert.equal(written.routingMode, "solo");
		assert.equal(harness.teamManager.routingMode, "solo");
		assert.ok(harness.emitted[0]?.includes(`Persisted routingMode=solo to ${expected}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable on without --persist patches the winning local file in place and preserves roles", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-autopersist-local-"));
	try {
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		mkdirSync(join(root, TEAM_PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(
			localPath,
			JSON.stringify({ schemaVersion: 4, routingMode: "solo", roles: { reviewer: { whenToUse: "Use for review", access: { tools: [] }, prompt: "<default>" } } }, null, 2),
		);
		const harness = installEnableCommand(root, buildLoadedConfig({ sourcePath: localPath }));
		await harness.run("on");
		const written = JSON.parse(readFileSync(localPath, "utf8"));
		assert.equal(written.routingMode, "team");
		assert.ok(written.roles?.reviewer, "roles must be preserved on auto-persist patch");
		assert.equal(harness.teamManager.routingMode, "team");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/team-enable off --persist global is still honored as an explicit override", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-autopersist-explicit-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-agent-team-autopersist-global-"));
	const globalPath = join(globalDir, TEAM_PROJECT_CONFIG_FILE);
	const previous = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
	process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = globalPath;
	try {
		const harness = installEnableCommand(root, buildLoadedConfig());
		await harness.run("off --persist global");
		const written = JSON.parse(readFileSync(globalPath, "utf8"));
		assert.equal(written.routingMode, "solo");
		const localPath = join(root, TEAM_PROJECT_CONFIG_DIR, TEAM_PROJECT_CONFIG_FILE);
		assert.equal(existsSync(localPath), false, "explicit --persist global must not also create a local stub");
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		else process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});
