import test from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../../src/control-plane/team-manager";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { registerCancelCommand } from "../../src/commands/cancel";
import { registerCopyCommand } from "../../src/commands/copy";
import { registerWorkerMessageCommands } from "../../src/commands/steer";
import { registerTeamCommand } from "../../src/commands/team";
import { MockWorkerHandle, MockWorkerTransport } from "../runtime/test-helpers";

interface CapturedCommand {
	name: string;
	spec: {
		description: string;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }>;
	};
}

function capture(): { pi: Record<string, unknown>; commands: CapturedCommand[] } {
	const commands: CapturedCommand[] = [];
	const pi = {
		registerCommand(name: string, spec: CapturedCommand["spec"]) {
			commands.push({ name, spec });
		},
	};
	return { pi, commands };
}

function makeTeamManager() {
	const workerManager = new WorkerManager(() => new MockWorkerHandle(new MockWorkerTransport()));
	const teamManager = new TeamManager({ workerManager });
	return { teamManager, workerManager };
}

test("worker-id completions return nothing once the first argument has whitespace", async () => {
	const { teamManager } = makeTeamManager();
	await teamManager.delegateTask({
		title: "Autocomplete probe",
		goal: "make w1 exist",
		profileName: "reviewer",
		cwd: process.cwd(),
	});

	const { pi, commands } = capture();
	const deps = { teamManager, emitText: () => {} };
	registerTeamCommand(pi as any, deps);
	registerWorkerMessageCommands(pi as any, deps);
	registerCancelCommand(pi as any, deps);
	registerCopyCommand(pi as any, deps);

	const names = commands.map((c) => c.name);
	assert.ok(names.includes("team"));
	assert.ok(names.includes("agent-steer"));
	assert.ok(names.includes("agent-followup"));
	assert.ok(names.includes("agent-cancel"));
	assert.ok(names.includes("team-copy"));

	for (const command of commands) {
		const complete = command.spec.getArgumentCompletions;
		if (!complete) continue;

		assert.ok(complete("").length >= 1, `${command.name} should offer completions on empty prefix`);
		assert.ok(complete("w").length >= 1, `${command.name} should offer worker completions on "w"`);
		assert.deepEqual(complete("all hello to me"), [], `${command.name} must not complete once arg contains whitespace`);
		assert.deepEqual(complete("w1 some follow-up text"), [], `${command.name} must not complete after first token is set`);
		assert.deepEqual(complete("w1 "), [], `${command.name} must not complete on trailing whitespace`);
	}
});
