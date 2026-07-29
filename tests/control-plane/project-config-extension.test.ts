import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = "none";

const SCAFFOLD_FRESHNESS_TOASTS_KEY = Symbol.for("pi-agents-team.scaffoldFreshnessToasts");

function resetProcessStableScaffoldFreshnessToasts(): void {
	const store = globalThis as typeof globalThis & Record<symbol, Set<string> | undefined>;
	store[SCAFFOLD_FRESHNESS_TOASTS_KEY]?.clear();
}

beforeEach(() => {
	resetProcessStableScaffoldFreshnessToasts();
});

import extension from "../../extensions/pi-agent-team/index";
import { createDefaultTeamState, DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	TEAM_PROFILE_NAMES,
	TEAM_PROJECT_CONFIG_DIR,
	TEAM_PROJECT_CONFIG_FILE,
	TEAM_SCAFFOLD_VERSION,
	type TeamProjectConfigFile,
	type WorkerRuntimeState,
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

function writeGlobalConfig(config: TeamProjectConfigFile): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-global-"));
	const path = projectConfigPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

function withGlobalConfigPath<T>(path: string, run: () => T): T {
	const previous = process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
	process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = path;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH;
		else process.env.PI_AGENT_TEAM_GLOBAL_CONFIG_PATH = previous;
	}
}

function createExtensionHarness(notifications: Array<{ message: string; level?: string }> = []) {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();

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

	return { tools, handlers, notifications };
}

function getDelegateTaskProfileDescription(tools: RegisteredTool[]): string {
	const delegateTask = tools.find((tool) => tool.name === "delegate_task") as RegisteredTool & {
		parameters?: { properties?: { profileName?: { description?: string } } };
	};
	return delegateTask?.parameters?.properties?.profileName?.description ?? "";
}

function createSessionContext(cwd: string, notifications: Array<{ message: string; level?: string }>) {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
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
}

function buildConfig(
	roleOverrides: Partial<TeamProjectConfigFile["roles"]> = {},
	configOverrides: Omit<Partial<TeamProjectConfigFile>, "schemaVersion" | "roles"> = {},
): TeamProjectConfigFile {
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
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		...configOverrides,
		roles: {
			...roles,
			...roleOverrides,
		},
	};
}

function makeWorkerState() {
	const state = createDefaultTeamState(DEFAULT_TEAM_CONFIG, 1);
	const worker: WorkerRuntimeState = {
		workerId: "w1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "completed",
		startedAt: 1,
		lastEventAt: 2,
		finalAnswer: "done",
		currentTask: {
			taskId: "task-1",
			title: "Review",
			goal: "Inspect",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: process.cwd(),
			contextHints: [],
			createdAt: 1,
		},
		pendingRelayQuestions: [],
		usage: { turns: 1, inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1234 },
	};
	state.activeWorkers[worker.workerId] = worker;
	return state;
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

test("initial factory config does not read project files before session trust", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-factory-safe-"));
	writeProjectConfig(root, {
		schemaVersion: 4,
		roles: {
			"project-only": { access: { tools: ["read"], write: false } } as any,
		},
		coordinationMode: "not-a-schema-field",
	} as any);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const { tools, handlers, notifications } = createExtensionHarness();
		const ctx = createSessionContext(root, notifications);

		const beforeStart = await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx) as { systemPrompt: string };

		assert.doesNotMatch(beforeStart.systemPrompt, /Pi Agents Team is disabled|Delegation is disabled/i);
		assert.doesNotMatch(getDelegateTaskProfileDescription(tools), /project-only|disabled/i);
	} finally {
		process.chdir(previousCwd);
	}
});

test("untrusted project config is ignored and cannot disable or inject roles", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-untrusted-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		enabled: false,
		roles: {
			"project-only": {
				whenToUse: "Use for untrusted project role injection.",
				access: { tools: ["read"], write: false },
			},
		},
	});

	const { tools, handlers, notifications } = createExtensionHarness();
	const ctx = {
		...createSessionContext(cwd, notifications),
		isProjectTrusted() {
			return false;
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const beforeStart = await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx) as { systemPrompt: string };
	const profileDescription = getDelegateTaskProfileDescription(tools);

	assert.ok(!notifications.some(({ message }) => /disabled|invalid agents-team\.json/i.test(message)));
	assert.doesNotMatch(beforeStart.systemPrompt, /project-only|Pi Agents Team is disabled|Delegation is disabled/i);
	assert.doesNotMatch(profileDescription, /project-only/);
	assert.match(profileDescription, /reviewer/);
});

test("trusted project config loads when ctx.isProjectTrusted returns true", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-trusted-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, {
		schemaVersion: 4,
		scaffoldVersion: TEAM_SCAFFOLD_VERSION,
		roles: {
			"trusted-only": {
				whenToUse: "Use only when the trusted project config is loaded.",
				access: { tools: ["read"], write: false },
			},
		},
	});

	const { tools, handlers, notifications } = createExtensionHarness();
	const ctx = {
		...createSessionContext(cwd, notifications),
		isProjectTrusted() {
			return true;
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const beforeStart = await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx) as { systemPrompt: string };

	assert.ok(notifications.some(({ message }) => /loaded session-frozen project config/i.test(message)));
	assert.match(beforeStart.systemPrompt, /trusted-only/);
	assert.match(getDelegateTaskProfileDescription(tools), /trusted-only/);
});

test("invalid project config warns on session start and blocks delegate_task", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(
		root,
		buildConfig({
			reviewer: {
				prompt: "./prompts/missing-reviewer.md",
			} as any,
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

test("disabled project config blocks delegate_task with current enable guidance", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-disabled-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { enabled: false }));

	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();

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
			notify() {},
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
	const delegateTask = tools.find((tool) => tool.name === "delegate_task");
	assert.ok(delegateTask);
	await assert.rejects(
		() => delegateTask!.execute("tool-1", {
			title: "Probe",
			goal: "Try to launch a worker",
			profileName: "reviewer",
		}, undefined, undefined, ctx),
		/Pi Agents Team is disabled.*set enabled: true.*\/reload/i,
	);
});

test("solo routing blocks delegate_task with /team-enable guidance", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-solo-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { routingMode: "solo" }));

	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();

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
			notify() {},
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
	const delegateTask = tools.find((tool) => tool.name === "delegate_task");
	assert.ok(delegateTask);
	await assert.rejects(
		() => delegateTask!.execute("tool-1", {
			title: "Probe",
			goal: "Try to launch a worker",
			profileName: "reviewer",
		}, undefined, undefined, ctx),
		/Team routing off\. Run \/team-enable on to delegate\./,
	);
});

test("fresh active local scaffold produces no scaffold freshness toast", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-fresh-local-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { scaffoldVersion: TEAM_SCAFFOLD_VERSION }));

	const { handlers, notifications } = createExtensionHarness();
	const ctx = createSessionContext(cwd, notifications);

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.ok(!notifications.some(({ message }) => /scaffoldVersion|scaffold freshness|has no scaffoldVersion/i.test(message)));
});

test("stale active local scaffold warning toasts once across factory reloads", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-stale-local-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { scaffoldVersion: 0 }));

	const notifications: Array<{ message: string; level?: string }> = [];
	const firstHarness = createExtensionHarness(notifications);
	const firstCtx = createSessionContext(cwd, notifications);

	await firstHarness.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);

	const secondHarness = createExtensionHarness(notifications);
	const secondCtx = createSessionContext(cwd, notifications);

	await secondHarness.handlers.get("session_start")?.({ reason: "reload" }, secondCtx);

	const freshnessToasts = notifications.filter(({ message }) => /active local agents-team\.json is scaffoldVersion 0/i.test(message));
	assert.equal(freshnessToasts.length, 1);
	assert.equal(freshnessToasts[0].level, "warning");
});

test("stale active global scaffold warning toasts once across factory reloads", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-stale-global-cwd-"));
	const globalPath = writeGlobalConfig(buildConfig({}, { scaffoldVersion: 0 }));

	await withGlobalConfigPath(globalPath, async () => {
		const notifications: Array<{ message: string; level?: string }> = [];
		const firstHarness = createExtensionHarness(notifications);
		const firstCtx = createSessionContext(cwd, notifications);

		await firstHarness.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);

		const secondHarness = createExtensionHarness(notifications);
		const secondCtx = createSessionContext(cwd, notifications);

		await secondHarness.handlers.get("session_start")?.({ reason: "reload" }, secondCtx);

		const freshnessToasts = notifications.filter(({ message }) => /active global agents-team\.json is scaffoldVersion 0/i.test(message));
		assert.equal(freshnessToasts.length, 1);
		assert.equal(freshnessToasts[0].level, "warning");
	});
});

test("stale non-winning global scaffold does not toast when local config wins", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-local-wins-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { scaffoldVersion: TEAM_SCAFFOLD_VERSION }));
	const globalPath = writeGlobalConfig(buildConfig({}, { scaffoldVersion: 0 }));

	await withGlobalConfigPath(globalPath, async () => {
		const { handlers, notifications } = createExtensionHarness();
		const ctx = createSessionContext(cwd, notifications);

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		assert.ok(!notifications.some(({ message }) => /active global agents-team\.json/i.test(message)));
		assert.ok(!notifications.some(({ message }) => /scaffoldVersion 0/i.test(message)));
	});
});

test("no config produces no scaffold freshness toast", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-no-config-"));
	const { handlers, notifications } = createExtensionHarness();
	const ctx = createSessionContext(cwd, notifications);

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.ok(!notifications.some(({ message }) => /scaffoldVersion|scaffold freshness|no scaffoldVersion/i.test(message)));
});

test("missing active scaffoldVersion produces one unknown-version warning across factory reloads", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-missing-scaffold-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { scaffoldVersion: undefined }));

	const notifications: Array<{ message: string; level?: string }> = [];
	const firstHarness = createExtensionHarness(notifications);
	const firstCtx = createSessionContext(cwd, notifications);

	await firstHarness.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);

	const secondHarness = createExtensionHarness(notifications);
	const secondCtx = createSessionContext(cwd, notifications);

	await secondHarness.handlers.get("session_start")?.({ reason: "reload" }, secondCtx);

	const freshnessToasts = notifications.filter(({ message }) => /active local agents-team\.json has no scaffoldVersion/i.test(message));
	assert.equal(freshnessToasts.length, 1);
	assert.equal(freshnessToasts[0].level, "warning");
});

test("schema-mismatched active config does not use scaffold freshness toast", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-schema-mismatch-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(resolve(projectConfigPath(root), ".."), { recursive: true });
	writeFileSync(projectConfigPath(root), JSON.stringify({ schemaVersion: 3, scaffoldVersion: 0, roles: {} }, null, 2));

	const { handlers, notifications } = createExtensionHarness();
	const ctx = createSessionContext(cwd, notifications);

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.ok(!notifications.some(({ message }) => /active local agents-team\.json is scaffoldVersion 0/i.test(message)));
});

test("fatal-parse active config produces invalid-config warning but no scaffold freshness toast", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-fatal-active-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(resolve(projectConfigPath(root), ".."), { recursive: true });
	writeFileSync(projectConfigPath(root), "{not json — project file broken");

	const { handlers, notifications } = createExtensionHarness();
	const ctx = createSessionContext(cwd, notifications);

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	assert.ok(notifications.some(({ message }) => /invalid agents-team\.json — delegation disabled/i.test(message)));
	assert.ok(!notifications.some(({ message }) => /scaffoldVersion|scaffold freshness|has no scaffoldVersion/i.test(message)));
});

test("ping_agents active returns restored registry snapshots after session_start", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-active-ping-restored-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig());
	const restored = makeWorkerState();
	const notifications: Array<{ message: string; level?: string }> = [];
	const { tools, handlers } = createExtensionHarness(notifications);
	const ctx = {
		...createSessionContext(cwd, notifications),
		sessionManager: {
			getBranch() {
				return [{
					type: "custom",
					customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
					data: restored,
				}];
			},
			getEntries() {
				return this.getBranch();
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "reload" }, ctx);
	const pingAgents = tools.find((tool) => tool.name === "ping_agents");
	assert.ok(pingAgents, "expected ping_agents tool to be registered");
	const response = await pingAgents.execute("call-1", { mode: "active" }, undefined, undefined, ctx) as {
		details?: { mode?: string; results?: Array<{ worker: WorkerRuntimeState }> };
	};
	const worker = response.details?.results?.[0]?.worker;

	assert.equal(response.details?.mode, "active");
	assert.equal(worker?.workerId, "w1");
	assert.equal(worker?.status, "completed");
	assert.match(worker?.error ?? "", /registry snapshot|not attached/i);
	assert.ok(worker?.lastSummary, "expected active ping to return a usable snapshot summary");
});

test("session lifecycle UI honors display.cost false", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-team-extension-display-cost-"));
	const cwd = join(root, "app");
	mkdirSync(cwd, { recursive: true });
	writeProjectConfig(root, buildConfig({}, { display: { cost: false } }));

	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const widgets: Array<string[] | undefined> = [];

	extension({
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	const state = makeWorkerState();
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			setWidget(_key: string, value: unknown) {
				if (Array.isArray(value)) {
					widgets.push(value);
				} else if (typeof value === "function") {
					const component = (value as (_tui: unknown, _theme: unknown) => { render: (width: number) => string[] })({}, {});
					widgets.push(component.render(100));
				} else {
					widgets.push(value as string[] | undefined);
				}
			},
			setTitle() {},
		},
		sessionManager: {
			getBranch() {
				return [{
					type: "custom",
					customType: DEFAULT_TEAM_CONFIG.persistence.stateCustomType,
					data: state,
				}];
			},
			getEntries() {
				return this.getBranch();
			},
		},
	} as any;

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await handlers.get("before_agent_start")?.({ systemPrompt: "base system prompt" }, ctx);

	const renderedWidgets = widgets.filter((widget): widget is string[] => Array.isArray(widget));
	assert.ok(renderedWidgets.some((widget) => widget.length > 0), "expected lifecycle to render a widget for restored worker state");
	for (const widget of renderedWidgets) {
		assert.ok(!widget.some((line) => line.includes("Σ")), `expected no cost row, saw:\n${widget.join("\n")}`);
		assert.ok(!widget.some((line) => line.includes("$0.1234")), `expected no cost value, saw:\n${widget.join("\n")}`);
	}
});
