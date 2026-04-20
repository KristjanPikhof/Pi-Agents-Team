import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTeamState } from "../../src/config";
import { markRestoredWorkersExited, restorePersistedTeamState } from "../../src/control-plane/persistence";

test("restorePersistedTeamState reads the latest matching custom entry", () => {
	const base = createDefaultTeamState();
	base.activeWorkers["worker-1"] = {
		workerId: "worker-1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "running",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};

	const restored = restorePersistedTeamState(
		[
			{ type: "custom", customType: "other", data: {} },
			{ type: "custom", customType: "pi-agent-team/state", data: base },
		],
		"pi-agent-team/state",
	);

	assert.equal(restored.activeWorkers["worker-1"]?.status, "running");
});

test("markRestoredWorkersExited converts live workers into exited snapshots", () => {
	const base = createDefaultTeamState();
	base.activeWorkers["worker-1"] = {
		workerId: "worker-1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "running",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};

	const { state: marked, markedCount } = markRestoredWorkersExited(base, "restore needed");
	assert.equal(marked.activeWorkers["worker-1"]?.status, "exited");
	assert.equal(marked.activeWorkers["worker-1"]?.error, "restore needed");
	assert.equal(markedCount, 1);
});

test("markRestoredWorkersExited maps session-start reasons to specific messages", () => {
	const buildLiveState = () => {
		const s = createDefaultTeamState();
		s.activeWorkers["worker-1"] = {
			workerId: "worker-1",
			profileName: "fixer",
			sessionMode: "worker",
			status: "running",
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			pendingRelayQuestions: [],
			usage: {
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			},
		};
		return s;
	};

	const resumed = markRestoredWorkersExited(buildLiveState(), "resume");
	assert.match(resumed.state.activeWorkers["worker-1"]?.error ?? "", /resumed/);

	const forked = markRestoredWorkersExited(buildLiveState(), "fork");
	assert.match(forked.state.activeWorkers["worker-1"]?.error ?? "", /forked/);
});

test("markRestoredWorkersExited reports zero when no workers were live", () => {
	const base = createDefaultTeamState();
	base.activeWorkers["worker-1"] = {
		workerId: "worker-1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "exited",
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		pendingRelayQuestions: [],
		usage: {
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		},
	};

	const { markedCount } = markRestoredWorkersExited(base, "reload");
	assert.equal(markedCount, 0);
});
