import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { _testing as routingTesting } from "../../src/commands/team-routing";
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

test("widget collapses to a single solo badge line when routingMode is solo", () => {
	const state = createDefaultTeamState();
	const teamLines = buildTeamWidgetLines(state, { routingMode: "team" });
	assert.deepEqual(teamLines, [], "team mode hides widget when no workers");

	const soloLines = buildTeamWidgetLines(state, { routingMode: "solo" });
	assert.equal(soloLines.length, 1);
	assert.match(soloLines[0]!, /Pi Agents Team — solo/);

	const soloStatus = buildTeamStatusLine(state, "solo");
	assert.match(soloStatus, /Pi Agents Team — solo/);
});

test("parseRoutingArgs accepts no args and --persist global|local", () => {
	assert.deepEqual(routingTesting.parseRoutingArgs(""), {});
	assert.deepEqual(routingTesting.parseRoutingArgs("  "), {});
	assert.deepEqual(routingTesting.parseRoutingArgs("--persist global"), { persist: "global" });
	assert.deepEqual(routingTesting.parseRoutingArgs("--persist local"), { persist: "local" });

	const missingScope = routingTesting.parseRoutingArgs("--persist");
	assert.match(missingScope.error ?? "", /--persist requires a scope/);

	const badScope = routingTesting.parseRoutingArgs("--persist nope");
	assert.match(badScope.error ?? "", /--persist requires a scope/);

	const garbage = routingTesting.parseRoutingArgs("foo");
	assert.match(garbage.error ?? "", /Unknown argument/);
});

test("persistRoutingMode writes routingMode atomically to a fresh project file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-routing-"));
	try {
		const result = routingTesting.persistRoutingMode("local", "solo", root);
		assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
		const written = JSON.parse(readFileSync((result as { path: string }).path, "utf8"));
		assert.equal(written.routingMode, "solo");
		assert.equal(typeof written.schemaVersion, "number");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
