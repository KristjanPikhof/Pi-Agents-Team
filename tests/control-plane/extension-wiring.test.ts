import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { _testing } from "../../extensions/pi-agent-team/index";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import { TeamManager, type AgentResult } from "../../src/control-plane/team-manager";
import type { WorkerRuntimeState } from "../../src/types";

interface RegisteredTool {
	name: string;
	renderCall?: (...args: any[]) => unknown;
	execute?: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
	name: string;
}

function makeWidgetState() {
	const state = createDefaultTeamState();
	const now = Date.now();
	state.activeWorkers.w1 = {
		workerId: "w1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "running",
		startedAt: now,
		lastEventAt: now,
		pendingRelayQuestions: [],
		usage: {
			turns: 1,
			inputTokens: 100,
			outputTokens: 25,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		},
		currentTask: {
			taskId: "task-1",
			title: "Review widget",
			goal: "Render RPC widget lines",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: now,
		},
	};
	return state;
}

test("extension mismatch notifier emits exactly one non-fatal session warning", () => {
	const warnings: string[] = [];
	const notifier = _testing.createPiVersionMismatchNotifier((message) => warnings.push(message));
	const event = {
		type: "pi_version_mismatch" as const,
		hostVersion: "0.80.6",
		workerVersion: "0.81.0",
		command: "custom-pi",
		message: "Pi Agents Team: host Pi 0.80.6 is launching worker Pi 0.81.0 via custom-pi; the supported version mismatch is non-fatal.",
	};
	notifier.notify(event);
	notifier.notify({ ...event, workerVersion: "0.82.0" });
	assert.deepEqual(warnings, [event.message]);
	notifier.reset();
	notifier.notify(event);
	assert.equal(warnings.length, 2, "a new session may warn once again");
});

test("extension registers control-plane tools and operator commands", () => {
	const tools: RegisteredTool[] = [];
	const commands: RegisteredCommand[] = [];
	const events: string[] = [];

	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push({ name });
		},
		on(event: string) {
			events.push(event);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["agent_cancel", "agent_message", "agent_result", "agent_status", "delegate_task", "ping_agents", "wait_for_agents"],
	);
	assert.deepEqual(
		commands.map((command) => command.name).sort(),
		["team", "team-copy", "team-enable", "team-init", "team-result", "team-steer", "team-stop"],
	);
	assert.ok(!commands.some((command) => command.name === "team-status"));
	assert.ok(!commands.some((command) => command.name === "agents"));
	assert.ok(!commands.some((command) => command.name === "ping-agents"));
	assert.ok(!commands.some((command) => command.name === "agent-result"));
	assert.ok(!commands.some((command) => command.name === "agent-cancel"));
	assert.ok(!commands.some((command) => command.name === "agent-close"));
	assert.ok(!commands.some((command) => command.name === "agent-steer"));
	assert.ok(!commands.some((command) => command.name === "agent-followup"));
	assert.ok(!commands.some((command) => command.name === "team-cost"));
	assert.ok(!commands.some((command) => command.name === "team-prune"));
	assert.ok(!commands.some((command) => command.name === "team-on"));
	assert.ok(!commands.some((command) => command.name === "team-off"));
	assert.ok(!commands.some((command) => command.name === "team-disable"));
	assert.ok(tools.every((tool) => typeof tool.renderCall === "function"));
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("agent_start"));
	assert.ok(events.includes("agent_end"));
	assert.ok(events.includes("agent_settled"));
	assert.ok(events.includes("before_agent_start"));
});

test("agent_result hides provisional final answers until terminal settlement", async () => {
	const tools: RegisteredTool[] = [];
	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on() {},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const resultTool = tools.find((tool) => tool.name === "agent_result");
	assert.ok(resultTool?.execute);
	const worker: WorkerRuntimeState = {
		workerId: "w1",
		profileName: "fixer",
		sessionMode: "worker",
		status: "running",
		startedAt: 1,
		lastEventAt: 2,
		pendingRelayQuestions: [],
		usage: { turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		finalAnswer: "headline: provisional answer",
	};
	const agentResult: AgentResult = { worker };
	const originalResolveWorkerId = TeamManager.prototype.resolveWorkerId;
	const originalGetWorkerResult = TeamManager.prototype.getWorkerResult;
	try {
		TeamManager.prototype.resolveWorkerId = () => "w1";
		TeamManager.prototype.getWorkerResult = () => agentResult;

		const beforeSettlement = await resultTool.execute("call-1", { workerId: "w1" });
		assert.match(beforeSettlement.content[0].text, /Final result is not ready/);
		assert.match(beforeSettlement.content[0].text, /wait_for_agents/);
		assert.doesNotMatch(beforeSettlement.content[0].text, /provisional answer/);
		assert.deepEqual(beforeSettlement.details, { workerId: "w1", status: "running", ready: false });
		assert.equal("worker" in beforeSettlement.details, false);
		assert.equal("finalAnswer" in beforeSettlement.details, false);

		worker.status = "completed";
		const afterSettlement = await resultTool.execute("call-2", { workerId: "w1" });
		assert.match(afterSettlement.content[0].text, /Result:\nheadline: provisional answer/);
		assert.strictEqual(afterSettlement.details, agentResult);
	} finally {
		TeamManager.prototype.resolveWorkerId = originalResolveWorkerId;
		TeamManager.prototype.getWorkerResult = originalGetWorkerResult;
	}
});

test("agent_result preserves terminal failure result behavior", async () => {
	const tools: RegisteredTool[] = [];
	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on() {},
		appendEntry() {},
		sendMessage() {},
	} as any);
	const resultTool = tools.find((tool) => tool.name === "agent_result");
	assert.ok(resultTool?.execute);
	const originalGetWorkerResult = TeamManager.prototype.getWorkerResult;
	try {
		for (const status of ["error", "aborted", "exited"] as const) {
			const terminalResult: AgentResult = {
				worker: {
					workerId: "w1",
					profileName: "fixer",
					sessionMode: "worker",
					status,
					startedAt: 1,
					lastEventAt: 2,
					pendingRelayQuestions: [],
					usage: { turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
					error: "terminal failure",
				},
			};
			TeamManager.prototype.getWorkerResult = () => terminalResult;
			const output = await resultTool.execute("call", { workerId: "w1" });
			assert.match(output.content[0].text, new RegExp(`Status: ${status}`));
			assert.strictEqual(output.details, terminalResult);
		}
	} finally {
		TeamManager.prototype.getWorkerResult = originalGetWorkerResult;
	}
});

test("persistence growth warning uses inclusive thresholds, deduplicates, and rearms below threshold", () => {
	const warnings: string[] = [];
	const monitor = _testing.createPersistenceGrowthMonitor((message) => warnings.push(message));
	monitor.replace({ recordCount: _testing.PERSISTENCE_RECORD_WARNING_THRESHOLD - 1, payloadBytes: 0 });
	assert.deepEqual(warnings, []);
	monitor.recordAppended(1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /append-only/);
	assert.match(warnings[0]!, /new session/);
	assert.match(warnings[0]!, /Reload, prune, and branch navigation do not shrink/);
	assert.match(warnings[0]!, /not the total session file size/);
	monitor.replace({ recordCount: _testing.PERSISTENCE_RECORD_WARNING_THRESHOLD + 50, payloadBytes: 0 });
	monitor.recordAppended(1);
	assert.equal(warnings.length, 1, "reload above threshold remains latched");
	monitor.replace({ recordCount: 0, payloadBytes: _testing.PERSISTENCE_BYTE_WARNING_THRESHOLD - 1 });
	monitor.recordAppended(1);
	assert.equal(warnings.length, 2, "below-threshold branch rearms the byte warning");
	assert.deepEqual(monitor.snapshot(), {
		recordCount: 1,
		payloadBytes: _testing.PERSISTENCE_BYTE_WARNING_THRESHOLD,
	});
});

test("extension counts persistence growth only after synchronous append succeeds", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const writes: unknown[] = [];
	const warnings: string[] = [];
	let failNextAppend = true;
	const seedRecord = {
		version: 2,
		kind: "worker_terminal",
		recordId: "seed",
		worker: {
			workerId: "w1", profileName: "fixer", status: "completed",
			startedAt: 1, lastEventAt: 2,
			usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		},
	};
	const branch = Array.from({ length: _testing.PERSISTENCE_RECORD_WARNING_THRESHOLD - 1 }, () => ({
		type: "custom", customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType, data: seedRecord,
	}));
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	try {
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
			appendEntry(_type: string, data: unknown) {
				if (failNextAppend) {
					failNextAppend = false;
					throw new Error("simulated append failure");
				}
				writes.push(data);
			},
			sendMessage() {},
		} as any);
		const ctx = {
			cwd: process.cwd(), hasUI: true,
			ui: {
				notify(message: string, level: string) { if (level === "warning" && message.includes("append-only")) warnings.push(message); },
				setStatus() {}, setWidget() {}, setTitle() {}, addAutocompleteProvider() {},
			},
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		} as any;
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		assert.deepEqual(warnings, [], "9,999 active-branch records are below threshold");

		const state = createDefaultTeamState();
		state.activeWorkers.w1 = {
			workerId: "w1", profileName: "fixer", sessionMode: "worker", status: "completed",
			requestedThinkingLevel: "off", effectiveThinkingLevel: "off",
			startedAt: 1, lastEventAt: 2, pendingRelayQuestions: [],
			usage: { ...seedRecord.worker.usage, inputTokens: 1 },
		};
		const listener = listeners.at(-1);
		assert.ok(listener);
		assert.throws(() => listener(state), /simulated append failure/);
		assert.deepEqual(warnings, [], "failed append is not counted toward threshold");
		listener(state);
		assert.equal(writes.length, 1, "failed transition is retried and then committed");
		assert.equal(warnings.length, 1, "successful 10,000th append triggers warning");
		listener(state);
		assert.equal(writes.length, 1, "committed transition is not duplicated");
		assert.equal(warnings.length, 1, "warning remains deduplicated");
	} finally {
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("middle append failure retries only the uncommitted suffix in order", () => {
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const attempted: string[] = [];
	const written: string[] = [];
	let calls = 0;
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	try {
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {}, registerCommand() {}, on() {}, sendMessage() {},
			appendEntry(_type: string, data: any) {
				calls += 1;
				attempted.push(data.recordId);
				if (calls === 2) throw new Error("middle failure");
				written.push(data.recordId);
			},
		} as any);
		const state = createDefaultTeamState();
		for (const workerId of ["w1", "w2", "w3"]) {
			state.activeWorkers[workerId] = { ...makeWidgetState().activeWorkers.w1!, workerId, status: "completed" };
		}
		const listener = listeners.at(-1)!;
		assert.throws(() => listener(state), /middle failure/);
		listener(state);
		assert.equal(written.length, 3);
		assert.deepEqual(attempted, [written[0], written[1], written[1], written[2]], "committed prefix is not retried");
	} finally {
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("teardown flush retries a final pending transition without another state event", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const writes: unknown[] = [];
	let calls = 0;
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	try {
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {}, registerCommand() {}, sendMessage() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
			appendEntry(_type: string, data: unknown) {
				calls += 1;
				if (calls === 1) throw new Error("initial failure");
				writes.push(data);
			},
		} as any);
		const state = createDefaultTeamState();
		state.activeWorkers.w1 = { ...makeWidgetState().activeWorkers.w1!, status: "completed" };
		assert.throws(() => listeners.at(-1)!(state), /initial failure/);
		await handlers.get("session_shutdown")?.({}, { hasUI: false } as any);
		assert.equal(calls, 2);
		assert.equal(writes.length, 1, "teardown performs one successful final retry");
	} finally {
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("persistent teardown append failure is bounded and warns once", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const errors: string[] = [];
	let calls = 0;
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	const originalConsoleError = console.error;
	try {
		console.error = (message?: unknown) => { errors.push(String(message)); };
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {}, registerCommand() {}, sendMessage() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
			appendEntry() { calls += 1; throw new Error("persistent failure"); },
		} as any);
		const state = createDefaultTeamState();
		state.activeWorkers.w1 = { ...makeWidgetState().activeWorkers.w1!, status: "completed" };
		assert.throws(() => listeners.at(-1)!(state), /persistent failure/);
		await handlers.get("session_shutdown")?.({}, { hasUI: false } as any);
		assert.equal(calls, 2, "flush makes one bounded retry");
		assert.equal(errors.filter((message) => message.includes("final retry")).length, 1);
	} finally {
		console.error = originalConsoleError;
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("ephemeral sessions suppress physical persistence growth warnings", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const warnings: string[] = [];
	const seedRecord = {
		version: 2, kind: "worker_pruned", recordId: "seed", workerId: "w1",
		usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
	};
	const branch = Array.from({ length: _testing.PERSISTENCE_RECORD_WARNING_THRESHOLD }, () => ({
		type: "custom", customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType, data: seedRecord,
	}));
	extension({
		registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
	} as any);
	const ctx = {
		cwd: process.cwd(), hasUI: true,
		ui: {
			notify(message: string, level: string) { if (level === "warning" && message.includes("append-only")) warnings.push(message); },
			setStatus() {}, setWidget() {}, setTitle() {}, addAutocompleteProvider() {},
		},
		sessionManager: { isPersisted: () => false, getBranch: () => branch, getEntries: () => branch },
	} as any;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(warnings, []);
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("tree navigation retries pending persistence once on the old leaf, never the new leaf", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const appendedLeaves: string[] = [];
	let leaf = "old";
	let calls = 0;
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	try {
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {}, registerCommand() {}, sendMessage() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
			appendEntry() {
				calls += 1;
				if (calls === 1) throw new Error("old leaf initial failure");
				appendedLeaves.push(leaf);
			},
		} as any);
		const ctx = {
			cwd: process.cwd(), hasUI: false,
			sessionManager: { getBranch: () => [], getEntries: () => [] },
		} as any;
		const state = createDefaultTeamState();
		state.activeWorkers.w1 = { ...makeWidgetState().activeWorkers.w1!, status: "completed" };
		assert.throws(() => listeners.at(-1)!(state), /old leaf initial failure/);
		await handlers.get("session_before_tree")?.({ preparation: {}, signal: undefined }, ctx);
		assert.deepEqual(appendedLeaves, ["old"], "bounded pre-tree retry still targets the old leaf");
		leaf = "new";
		await handlers.get("session_tree")?.({ oldLeafId: "old", newLeafId: "new" }, ctx);
		assert.deepEqual(appendedLeaves, ["old"], "post-tree replacement does not repeat the old transition");
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("persistent pre-tree failure is warned and isolated from the new leaf", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const listeners: Array<(state: ReturnType<typeof createDefaultTeamState>) => void> = [];
	const attempts: string[] = [];
	const warnings: string[] = [];
	let leaf = "old";
	const originalOnStateChange = TeamManager.prototype.onStateChange;
	try {
		TeamManager.prototype.onStateChange = function (listener: (state: any) => void) {
			listeners.push(listener);
			return () => {};
		};
		extension({
			registerTool() {}, registerCommand() {}, sendMessage() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
			appendEntry() { attempts.push(leaf); throw new Error("persistent old failure"); },
		} as any);
		const ctx = {
			cwd: process.cwd(), hasUI: true,
			ui: {
				notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
				setStatus() {}, setWidget() {}, setTitle() {}, addAutocompleteProvider() {},
			},
			sessionManager: { getBranch: () => [], getEntries: () => [] },
		} as any;
		const state = createDefaultTeamState();
		state.activeWorkers.w1 = { ...makeWidgetState().activeWorkers.w1!, status: "completed" };
		assert.throws(() => listeners.at(-1)!(state), /persistent old failure/);
		await handlers.get("session_before_tree")?.({ preparation: {}, signal: undefined }, ctx);
		assert.deepEqual(attempts, ["old", "old"], "pre-tree processing makes one bounded retry");
		assert.equal(warnings.filter((message) => message.includes("old-branch records were isolated")).length, 1);
		leaf = "new";
		await handlers.get("session_tree")?.({ oldLeafId: "old", newLeafId: "new" }, ctx);
		assert.deepEqual(attempts, ["old", "old"], "unresolved old record is never attempted at the new leaf");
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		TeamManager.prototype.onStateChange = originalOnStateChange;
	}
});

test("extension restores only the active Pi branch and does not checkpoint on startup", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const tools: RegisteredTool[] = [];
	const writes: unknown[] = [];
	const active = createDefaultTeamState();
	active.activeWorkers.w1 = {
		...makeWidgetState().activeWorkers.w1!,
		status: "completed",
		finalAnswer: "legacy final answer must be discarded",
	};
	const inactive = createDefaultTeamState();
	inactive.activeWorkers.w9 = { ...active.activeWorkers.w1, workerId: "w9" };
	let activeBranch = active;

	extension({
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) { handlers.set(event, handler); },
		appendEntry(_type: string, data: unknown) { writes.push(data); },
		sendMessage() {},
	} as any);
	const ctx = {
		cwd: process.cwd(), hasUI: false,
		sessionManager: {
			getEntries: () => [{ type: "custom", customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType, data: inactive }],
			getBranch: () => [{ type: "custom", customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType, data: activeBranch }],
		},
	} as any;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(writes, [], "session restore must not append a checkpoint");
	const result = await tools.find((tool) => tool.name === "agent_result")!.execute!("call", { workerId: "w1" });
	assert.match(result.content[0].text, /live-session-only/);
	await assert.rejects(() => tools.find((tool) => tool.name === "agent_result")!.execute!("call", { workerId: "w9" }), /Unknown worker/);

	activeBranch = inactive;
	await handlers.get("session_tree")?.({}, ctx);
	await assert.rejects(() => tools.find((tool) => tool.name === "agent_result")!.execute!("call", { workerId: "w1" }), /Unknown worker/);
	const branchResult = await tools.find((tool) => tool.name === "agent_result")!.execute!("call", { workerId: "w9" });
	assert.match(branchResult.content[0].text, /live-session-only/);
	assert.deepEqual(writes, [], "tree navigation restore must not append a checkpoint");
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("extension registers natural autocomplete provider when UI API is available", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const autocompleteFactories: Array<(current: any) => any> = [];

	extension({
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-autocomplete-"));
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			setWidget() {},
			setTitle() {},
			addAutocompleteProvider(factory: (current: any) => any) {
				autocompleteFactories.push(factory);
			},
		},
		sessionManager: {
			getEntries() {
				return [];
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.equal(autocompleteFactories.length, 1);
	const provider = autocompleteFactories[0]!({
		async getSuggestions() {
			return null;
		},
		applyCompletion() {},
	} as any);
	assert.deepEqual(provider.triggerCharacters, ["@", "$"]);
});

test("extension emits plain widget lines in RPC mode even when hasUI=true", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const widgets: unknown[] = [];

	extension({
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-rpc-widget-"));
	const ctx = {
		mode: "rpc",
		cwd,
		hasUI: true,
		ui: {
			theme: undefined,
			notify() {},
			setStatus() {},
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
			setTitle() {},
			addAutocompleteProvider() {},
		},
		sessionManager: {
			getEntries() {
				return [{
					type: "custom",
					customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
					data: makeWidgetState(),
				}];
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	const definedWidgets = widgets.filter((value) => value !== undefined);
	assert.ok(definedWidgets.length > 0, "expected at least one widget update");
	assert.ok(definedWidgets.every((value) => Array.isArray(value)), "RPC widget updates must be string arrays");
	assert.ok(definedWidgets.flat().every((line) => typeof line === "string"), "RPC widget lines must be strings");
	assert.ok(definedWidgets.every((value) => typeof value !== "function"), "RPC widget updates must not be component factories");

	await handlers.get("session_shutdown")?.({}, ctx);
});

test("extension clears empty RPC widget with undefined", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const widgets: unknown[] = [];

	extension({
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-empty-rpc-widget-"));
	const ctx = {
		mode: "rpc",
		cwd,
		hasUI: true,
		ui: {
			theme: undefined,
			notify() {},
			setStatus() {},
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
			setTitle() {},
			addAutocompleteProvider() {},
		},
		sessionManager: {
			getEntries() {
				return [];
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.ok(widgets.includes(undefined), "empty active team state must clear the widget");
	assert.ok(widgets.every((value) => value === undefined), "empty active team state must not register blank arrays");

	await handlers.get("session_shutdown")?.({}, ctx);
});

test("extension keeps the orchestrator working between agent_end and agent_settled", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const statusLines: Array<string | undefined> = [];

	extension({
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-agent-start-"));
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify() {},
			setStatus(_key: string, value: string | undefined) {
				statusLines.push(value);
			},
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
	assert.match(statusLines.at(-1) ?? "", /Orchestrator · Idle/);

	await handlers.get("agent_start")?.({}, ctx);
	assert.match(statusLines.at(-1) ?? "", /Orchestrator · Working\.\.\./);

	await handlers.get("agent_end")?.({}, ctx);
	assert.match(statusLines.at(-1) ?? "", /Orchestrator · Working\.\.\./);

	await handlers.get("agent_settled")?.({}, ctx);
	assert.match(statusLines.at(-1) ?? "", /Orchestrator · Idle/);

	await handlers.get("session_shutdown")?.({}, ctx);
});

test("extension rotates footer tips with an unref'd timer and clears it on shutdown", async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const statusLines: Array<string | undefined> = [];
	const callbacks: Array<() => void> = [];
	const timers: unknown[] = [];
	let intervalMs: number | undefined;
	let unrefCount = 0;
	let clearedTimer: unknown;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;

	try {
		(globalThis as any).setInterval = (callback: () => void, ms?: number) => {
			callbacks.push(callback);
			intervalMs = ms;
			const timer = {
				unref() {
					unrefCount += 1;
				},
			};
			timers.push(timer);
			return timer;
		};
		(globalThis as any).clearInterval = (timer: unknown) => {
			clearedTimer = timer;
		};

		extension({
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
				handlers.set(event, handler);
			},
			appendEntry() {},
			sendMessage() {},
		} as any);

		const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-tip-timer-"));
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify() {},
				setStatus(_key: string, value: string | undefined) {
					statusLines.push(value);
				},
				setWidget() {},
				setTitle() {},
			},
			sessionManager: {
				getEntries() {
					return [{
						type: "custom",
						customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
						data: makeWidgetState(),
					}];
				},
			},
		} as any;

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		assert.equal(intervalMs, 15_000);
		assert.equal(unrefCount, 1);
		assert.match(statusLines.at(-1) ?? "", /Orchestrator · Idle · Tip: Use \/team to view workers/);

		callbacks[0]?.();
		assert.match(statusLines.at(-1) ?? "", /Orchestrator · Idle · Tip: Use \/team-result <id> for final output/);

		await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "work" }, ctx);
		assert.match(statusLines.at(-1) ?? "", /Orchestrator · Working\.\.\./);

		await handlers.get("agent_end")?.({ messages: [] }, ctx);
		assert.match(statusLines.at(-1) ?? "", /Orchestrator · Working\.\.\./);

		await handlers.get("agent_settled")?.({}, ctx);
		assert.match(statusLines.at(-1) ?? "", /Orchestrator · Idle/);

		await handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(clearedTimer, timers[0]);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});
