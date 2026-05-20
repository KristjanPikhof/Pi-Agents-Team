import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "typebox/value";
import { TeamProjectConfigSchema } from "../config";
import { findNearestProjectConfigPath, getProjectConfigPathForScope } from "../project-config/loader";
import { formatCommandWarning } from "../ui/display-grammar";
import type { LoadedTeamProjectConfig } from "../types";
import { TEAM_PROJECT_SCHEMA_VERSION } from "../types";
import { atomicWriteFileSync } from "../util/backup";
import type { RoutingMode, TeamManager } from "../control-plane/team-manager";

export interface TeamEnableCommandDependencies {
	getTeamManager: () => TeamManager;
	getProjectConfig: () => LoadedTeamProjectConfig;
	emitText: (ctx: ExtensionContext, text: string) => void;
	ensureNotReloading: () => void;
}

interface ParsedArgs {
	mode?: RoutingMode;
	persist?: "global" | "local";
	persistAliasDeprecated?: boolean;
	error?: string;
}

function parseTeamEnableArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { error: "Usage: /team-enable on|off [--local|--global]" };
	}
	let mode: RoutingMode | undefined;
	let persist: "global" | "local" | undefined;
	let persistAliasDeprecated = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (token === "on" || token === "off") {
			if (mode) {
				return { error: `Specify on|off only once.` };
			}
			mode = token === "on" ? "team" : "solo";
			continue;
		}
		if (token === "--local" || token === "--global") {
			const scope = token === "--local" ? "local" : "global";
			if (persist && persist !== scope) {
				return { error: `Specify only one persistence scope.` };
			}
			persist = scope;
			continue;
		}
		if (token === "--persist") {
			const scope = tokens[i + 1];
			if (scope !== "global" && scope !== "local") {
				return { error: `--persist requires a scope: --persist global|local.` };
			}
			if (persist && persist !== scope) {
				return { error: `Specify only one persistence scope.` };
			}
			persist = scope;
			persistAliasDeprecated = true;
			i += 1;
			continue;
		}
		return { error: `Unknown argument: ${token}.` };
	}
	if (!mode) {
		return { error: "Usage: /team-enable on|off [--local|--global]" };
	}
	return persistAliasDeprecated ? { mode, persist, persistAliasDeprecated } : { mode, persist };
}

interface CompletionItem {
	value: string;
	label: string;
	description: string;
}

function buildTeamEnableCompletions(prefix: string): CompletionItem[] {
	const hasTrailingSpace = /\s$/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);
	const modeTokens = tokens.filter((token) => token === "on" || token === "off");
	const hasMode = modeTokens.length > 0;
	const hasPersistence = tokens.some((token) => token === "--local" || token === "--global" || token === "--persist");
	const currentToken = hasTrailingSpace ? "" : (tokens.at(-1) ?? "");

	if (!hasMode) {
		return [
			{ value: "on", label: "on", description: "team routing on (delegate_task gated open)" },
			{ value: "off", label: "off", description: "team routing off (Pi answers directly)" },
		].filter((item) => item.value.startsWith(currentToken));
	}

	if (hasPersistence) return [];

	return [
		{ value: "--local", label: "--local", description: "persist routingMode to project agents-team.json" },
		{ value: "--global", label: "--global", description: "persist routingMode to global agents-team.json" },
	].filter((item) => item.value.startsWith(currentToken));
}

export function deriveScopeFromSourcePath(sourcePath: string, cwd: string): "global" | "local" | undefined {
	const localPath = getProjectConfigPathForScope("project", cwd);
	if (localPath && sourcePath === localPath) return "local";
	const globalPath = getProjectConfigPathForScope("global", cwd);
	if (globalPath && sourcePath === globalPath) return "global";
	return undefined;
}

export function persistRoutingMode(
	scope: "global" | "local",
	routingMode: RoutingMode,
	cwd: string,
): { path: string; warning?: string } | { error: string } {
	const internalScope = scope === "local" ? "project" : "global";
	const path = getProjectConfigPathForScope(internalScope, cwd);
	if (!path) {
		return { error: `Global agents-team.json is disabled (PI_AGENT_TEAM_GLOBAL_CONFIG_PATH=none). Cannot persist globally.` };
	}

	let raw: unknown = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			return { error: `Cannot persist: ${path} is unparsable (${error instanceof Error ? error.message : String(error)}). Fix the file or back it up first.` };
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { error: `Cannot persist: ${path} top-level value is not an object.` };
		}
	}

	const merged: Record<string, unknown> = {
		schemaVersion: TEAM_PROJECT_SCHEMA_VERSION,
		...(raw as Record<string, unknown>),
		routingMode,
	};

	const errors = Array.from(Value.Errors(TeamProjectConfigSchema, merged));
	const warnings: string[] = [];
	if (errors.length > 0) {
		warnings.push(`Note: ${path} does not match the current schema (${errors[0]?.message ?? "unknown error"}). The routingMode field was patched but the rest of the file was left untouched.`);
	}
	if (scope === "global") {
		const localPath = findNearestProjectConfigPath(cwd);
		if (localPath && localPath !== path) {
			warnings.push(`Warning: project-local config exists at ${localPath} and shadows this global routingMode in this project.`);
		}
	}

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });

	return warnings.length > 0 ? { path, warning: warnings.join("\n") } : { path };
}

export function runSetRoutingMode(
	mode: RoutingMode,
	persist: "global" | "local" | undefined,
	ctx: ExtensionContext,
	deps: TeamEnableCommandDependencies,
	options: { persistAliasDeprecated?: boolean } = {},
): void {
	try {
		deps.ensureNotReloading();
	} catch (error) {
		ctx.ui.notify(formatCommandWarning(error instanceof Error ? error.message : String(error)), "warning");
		return;
	}

	const projectConfig = deps.getProjectConfig();
	if (mode === "team" && !projectConfig.enabled) {
		ctx.ui.notify(
			formatCommandWarning("Pi Agents Team is disabled — enable it by editing agents-team.json (set enabled: true), then /reload."),
			"warning",
		);
		return;
	}
	if (mode === "team" && !projectConfig.delegationEnabled) {
		const firstError = projectConfig.diagnostics.find((diagnostic) => diagnostic.severity === "error");
		const sourceSuffix = projectConfig.sourcePath ? ` at ${projectConfig.sourcePath}` : "";
		const errorSuffix = firstError ? `: ${firstError.message}` : ".";
		ctx.ui.notify(
			formatCommandWarning(`Cannot enable team routing: agents-team.json is invalid${sourceSuffix}${errorSuffix} Fix the config and /reload first.`),
			"warning",
		);
		return;
	}

	const manager = deps.getTeamManager();
	const previousMode = manager.routingMode;

	const lines: string[] = [];
	let shouldApplyLiveMode = true;

	if (persist) {
		if (options.persistAliasDeprecated) {
			lines.push("Note: --persist is deprecated; use --local or --global instead.");
		}
		const result = persistRoutingMode(persist, mode, ctx.cwd);
		if ("error" in result) {
			shouldApplyLiveMode = false;
			lines.push(`Persistence failed: ${result.error}`);
			lines.push(`Routing mode remains ${previousMode}.`);
		} else {
			lines.push(`Persisted routingMode=${mode} to ${result.path}.`);
			if (result.warning) lines.push(result.warning);
		}
	} else {
		lines.push("Session-only change; resets on /reload or restart. Use --local or --global to persist.");
	}

	if (shouldApplyLiveMode) {
		manager.setRoutingMode(mode);
		lines.unshift(`${mode === "team" ? "Team enabled" : "Team disabled"} — routing mode: ${previousMode} → ${mode}.`);
	}

	if (shouldApplyLiveMode && mode === "solo") {
		lines.push("delegate_task is gated off; agent_status, agent_result, agent_message, ping_agents, wait_for_agents, agent_cancel remain callable.");
	}

	deps.emitText(ctx, lines.join("\n"));
}

export function registerTeamEnableCommand(pi: ExtensionAPI, dependencies: TeamEnableCommandDependencies): void {
	pi.registerCommand("team-enable", {
		description: "Turn team routing on or off for this session, or persist explicitly: /team-enable on|off [--local|--global]",
		getArgumentCompletions: (prefix) => buildTeamEnableCompletions(prefix),
		handler: async (args, ctx) => {
			const parsed = parseTeamEnableArgs(args);
			if (parsed.error || !parsed.mode) {
				ctx.ui.notify(formatCommandWarning(parsed.error ?? "Usage: /team-enable on|off [--local|--global]"), "warning");
				return;
			}
			runSetRoutingMode(parsed.mode, parsed.persist, ctx, dependencies, { persistAliasDeprecated: parsed.persistAliasDeprecated });
		},
	});
}

export const _testing = { parseTeamEnableArgs, buildTeamEnableCompletions, persistRoutingMode, deriveScopeFromSourcePath };
