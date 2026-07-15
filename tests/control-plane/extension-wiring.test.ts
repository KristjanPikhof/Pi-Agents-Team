import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { _testing } from "../../extensions/pi-agent-team/index";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import { TeamManager } from "../../src/control-plane/team-manager";
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
	const originalResolveWorkerId = TeamManager.prototype.resolveWorkerId;
	const originalGetWorkerResult = TeamManager.prototype.getWorkerResult;
	try {
		TeamManager.prototype.resolveWorkerId = () => "w1";
		TeamManager.prototype.getWorkerResult = () => ({ worker });

		const beforeSettlement = await resultTool.execute("call-1", { workerId: "w1" });
		assert.match(beforeSettlement.content[0].text, /Final result is not ready/);
		assert.match(beforeSettlement.content[0].text, /wait_for_agents/);
		assert.doesNotMatch(beforeSettlement.content[0].text, /provisional answer/);
		assert.deepEqual(beforeSettlement.details, { workerId: "w1", status: "running", ready: false });

		worker.status = "completed";
		const afterSettlement = await resultTool.execute("call-2", { workerId: "w1" });
		assert.match(afterSettlement.content[0].text, /Result:\nheadline: provisional answer/);
		assert.equal(afterSettlement.details.worker.finalAnswer, "headline: provisional answer");
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
			TeamManager.prototype.getWorkerResult = () => ({
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
			});
			const output = await resultTool.execute("call", { workerId: "w1" });
			assert.match(output.content[0].text, new RegExp(`Status: ${status}`));
			assert.equal(output.details.worker.status, status);
		}
	} finally {
		TeamManager.prototype.getWorkerResult = originalGetWorkerResult;
	}
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
