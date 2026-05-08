import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "typebox/value";
import { TeamProjectConfigSchema } from "../config";
import { getProjectConfigPathForScope } from "../project-config/loader";
import type { LoadedTeamProjectConfig, TeamProjectConfigFile } from "../types";
import { TEAM_PROJECT_SCHEMA_VERSION } from "../types";
import { atomicWriteFileSync } from "../util/backup";
import type { RoutingMode, TeamManager } from "../control-plane/team-manager";

interface RoutingCommandDependencies {
	getTeamManager: () => TeamManager;
	getProjectConfig: () => LoadedTeamProjectConfig;
	emitText: (ctx: ExtensionContext, text: string) => void;
	ensureNotReloading: () => void;
}

interface ParsedArgs {
	persist?: "global" | "local";
	error?: string;
}

function parseRoutingArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return {};
	let persist: "global" | "local" | undefined;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (token === "--persist") {
			const scope = tokens[i + 1];
			if (scope !== "global" && scope !== "local") {
				return { error: `--persist requires a scope: --persist global|local.` };
			}
			persist = scope;
			i += 1;
			continue;
		}
		return { error: `Unknown argument: ${token}.` };
	}
	return { persist };
}

function deriveScopeFromSourcePath(sourcePath: string, cwd: string): "global" | "local" | undefined {
	const localPath = getProjectConfigPathForScope("project", cwd);
	if (localPath && sourcePath === localPath) return "local";
	const globalPath = getProjectConfigPathForScope("global", cwd);
	if (globalPath && sourcePath === globalPath) return "global";
	return undefined;
}

function persistRoutingMode(scope: "global" | "local", routingMode: RoutingMode, cwd: string): { path: string; warning?: string } | { error: string } {
	const internalScope = scope === "local" ? "project" : "global";
	const path = getProjectConfigPathForScope(internalScope, cwd);
	if (!path) {
		return { error: `Global agents-team.json is disabled (PI_AGENT_TEAM_GLOBAL_CONFIG_PATH=none). Cannot --persist global.` };
	}

	let raw: unknown = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			return { error: `Cannot --persist: ${path} is unparsable (${error instanceof Error ? error.message : String(error)}). Fix the file or back it up first.` };
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { error: `Cannot --persist: ${path} top-level value is not an object.` };
		}
	}

	const merged: Record<string, unknown> = {
		schemaVersion: TEAM_PROJECT_SCHEMA_VERSION,
		...(raw as Record<string, unknown>),
		routingMode,
	};

	const errors = Array.from(Value.Errors(TeamProjectConfigSchema, merged));
	const schemaWarning = errors.length > 0
		? `Note: ${path} does not match the current schema (${errors[0]?.message ?? "unknown error"}). The routingMode field was patched but the rest of the file was left untouched.`
		: undefined;

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });

	return schemaWarning ? { path, warning: schemaWarning } : { path };
}

function runSetRoutingMode(
	mode: RoutingMode,
	args: string,
	ctx: ExtensionContext,
	deps: RoutingCommandDependencies,
): void {
	try {
		deps.ensureNotReloading();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	const parsed = parseRoutingArgs(args);
	if (parsed.error) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}

	const projectConfig = deps.getProjectConfig();
	if (mode === "team" && !projectConfig.enabled) {
		ctx.ui.notify(
			"Pi Agents Team is disabled — enable first with /team-enable global or /team-enable local, then /reload, then /team-on.",
			"warning",
		);
		return;
	}
	if (mode === "team" && !projectConfig.delegationEnabled) {
		const firstError = projectConfig.diagnostics.find((diagnostic) => diagnostic.severity === "error");
		const sourceSuffix = projectConfig.sourcePath ? ` at ${projectConfig.sourcePath}` : "";
		const errorSuffix = firstError ? `: ${firstError.message}` : ".";
		ctx.ui.notify(
			`Cannot enable team routing: agents-team.json is invalid${sourceSuffix}${errorSuffix} Fix the config and /reload first.`,
			"warning",
		);
		return;
	}

	const manager = deps.getTeamManager();
	const previousMode = manager.routingMode;
	manager.setRoutingMode(mode);

	const lines: string[] = [
		`Routing mode: ${previousMode} → ${mode}.`,
	];

	const explicitScope = parsed.persist;
	const autoScope: "global" | "local" | undefined = explicitScope
		? undefined
		: (projectConfig.sourcePath ? deriveScopeFromSourcePath(projectConfig.sourcePath, ctx.cwd) : undefined) ?? "local";
	const persistScope = explicitScope ?? autoScope;
	if (persistScope) {
		const result = persistRoutingMode(persistScope, mode, ctx.cwd);
		if ("error" in result) {
			lines.push(explicitScope ? `--persist failed: ${result.error}` : `Could not persist routingMode: ${result.error}`);
		} else {
			lines.push(`Persisted routingMode=${mode} to ${result.path}.`);
			if (result.warning) lines.push(result.warning);
		}
	}

	if (mode === "solo") {
		lines.push("delegate_task is gated off; agent_status, agent_result, agent_message, ping_agents, wait_for_agents, agent_cancel remain callable.");
	}

	deps.emitText(ctx, lines.join("\n"));
}

export function registerTeamRoutingCommands(pi: ExtensionAPI, dependencies: RoutingCommandDependencies): void {
	pi.registerCommand("team-on", {
		description: "Turn team routing on and persist routingMode to the active agents-team.json (override scope with --persist global|local)",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return ["--persist"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value, description: "persist routingMode to agents-team.json" }));
		},
		handler: async (args, ctx) => runSetRoutingMode("team", args, ctx, dependencies),
	});

	pi.registerCommand("team-off", {
		description: "Turn team routing off for this session — Pi answers directly without delegating: /team-off [--persist global|local]",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return ["--persist"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value, description: "persist routingMode to agents-team.json" }));
		},
		handler: async (args, ctx) => runSetRoutingMode("solo", args, ctx, dependencies),
	});
}

export const _testing = { parseRoutingArgs, persistRoutingMode };
