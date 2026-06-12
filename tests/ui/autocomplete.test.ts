import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEAM_CONFIG } from "../../src/config";
import {
	buildRoleAutocompleteItems,
	buildWorkerAutocompleteItems,
	createTeamAutocompleteProvider,
	extractTeamAutocompleteToken,
	registerTeamAutocomplete,
} from "../../src/ui/autocomplete";
import type { WorkerRuntimeState } from "../../src/types";

function makeWorker(overrides: Partial<WorkerRuntimeState> = {}): WorkerRuntimeState {
	return {
		workerId: "w1",
		profileName: "reviewer",
		sessionMode: "worker",
		status: "running",
		requestedThinkingLevel: "medium",
		effectiveThinkingLevel: "medium",
		startedAt: 1,
		lastEventAt: 2,
		currentTask: {
			taskId: "t1",
			title: "Inspect runtime",
			goal: "Review runtime",
			requestedBy: "orchestrator",
			profileName: "reviewer",
			cwd: "/repo",
			contextHints: [],
			createdAt: 1,
		},
		pendingRelayQuestions: [],
		usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
		...overrides,
	};
}

test("extractTeamAutocompleteToken recognizes @worker and $role after whitespace or start", () => {
	assert.deepEqual(extractTeamAutocompleteToken("@w"), { kind: "worker", query: "w", prefix: "@w" });
	assert.deepEqual(extractTeamAutocompleteToken("ask @"), { kind: "worker", query: "", prefix: "@" });
	assert.deepEqual(extractTeamAutocompleteToken("use $fix"), { kind: "role", query: "fix", prefix: "$fix" });
	assert.equal(extractTeamAutocompleteToken("email@example"), undefined);
	assert.equal(extractTeamAutocompleteToken("/team w"), undefined);
});

test("buildWorkerAutocompleteItems formats live worker tokens", () => {
	const items = buildWorkerAutocompleteItems([
		makeWorker(),
		makeWorker({ workerId: "w2", profileName: "fixer", status: "idle" }),
	], "w");

	assert.deepEqual(items.map((item) => item.value), ["@w1", "@w2"]);
	assert.match(items[0]?.description ?? "", /reviewer · running · Inspect runtime/);
});

test("buildRoleAutocompleteItems formats configured role tokens", () => {
	const items = buildRoleAutocompleteItems(DEFAULT_TEAM_CONFIG.profiles, "fix");
	assert.deepEqual(items.map((item) => item.value), ["$fixer"]);
	assert.match(items[0]?.description ?? "", /bounded code changes/i);
});

test("createTeamAutocompleteProvider suggests team tokens and delegates fallback behavior", async () => {
	let fallbackCalls = 0;
	const current = {
		async getSuggestions() {
			fallbackCalls += 1;
			return { prefix: "/te", items: [{ value: "/team", label: "/team", description: "slash command" }] };
		},
		applyCompletion() {
			return { lines: ["applied"], cursorLine: 0, cursorCol: 7 };
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	} as any;
	const provider = createTeamAutocompleteProvider(current, {
		getWorkers: () => [makeWorker()],
		getProfiles: () => DEFAULT_TEAM_CONFIG.profiles,
	});

	assert.deepEqual((provider as any).triggerCharacters, ["@", "$"]);
	const workerSuggestions = await provider.getSuggestions(["ask @w"], 0, "ask @w".length, { signal: new AbortController().signal } as any);
	assert.equal(workerSuggestions?.prefix, "@w");
	assert.equal(workerSuggestions?.items[0]?.value, "@w1");

	const roleSuggestions = await provider.getSuggestions(["use $fix"], 0, "use $fix".length, { signal: new AbortController().signal } as any);
	assert.equal(roleSuggestions?.prefix, "$fix");
	assert.equal(roleSuggestions?.items[0]?.value, "$fixer");

	const slashFallback = await provider.getSuggestions(["/te"], 0, 3, { signal: new AbortController().signal } as any);
	assert.equal(slashFallback?.items[0]?.value, "/team");
	const noMatchFallback = await provider.getSuggestions(["ask @missing"], 0, "ask @missing".length, { signal: new AbortController().signal } as any);
	assert.equal(noMatchFallback?.items[0]?.value, "/team");
	assert.equal(fallbackCalls, 2);
	assert.deepEqual(provider.applyCompletion(["ask @w"], 0, 6, { value: "@w1" } as any, "@w"), {
		lines: ["applied"],
		cursorLine: 0,
		cursorCol: 7,
	});
	assert.equal(provider.shouldTriggerFileCompletion?.(["ask @w"], 0, 6), false);
	assert.equal(provider.shouldTriggerFileCompletion?.(["src/"], 0, 4), true);
});

test("registerTeamAutocomplete is guarded by UI and API availability", () => {
	assert.equal(registerTeamAutocomplete({ hasUI: false, ui: {} }, { getWorkers: () => [], getProfiles: () => [] }), false);
	assert.equal(registerTeamAutocomplete({ hasUI: true, ui: {} }, { getWorkers: () => [], getProfiles: () => [] }), false);

	let registered = 0;
	const ok = registerTeamAutocomplete({
		hasUI: true,
		ui: {
			addAutocompleteProvider() {
				registered += 1;
			},
		},
	}, { getWorkers: () => [], getProfiles: () => [] });
	assert.equal(ok, true);
	assert.equal(registered, 1);
});
