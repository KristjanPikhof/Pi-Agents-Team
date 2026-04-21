import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { TeamProjectConfigSchema } from "../config";
import { getProjectConfigPathForScope } from "../project-config/loader";
import type { TeamConfigScope, TeamProjectConfigFile } from "../types";

interface ToggleCommandDependencies {
	emitText: (ctx: ExtensionContext, text: string) => void;
}

type ToggleScope = "global" | "local";

function parseToggleArgs(args: string): { scope?: ToggleScope; error?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return {};
	if (tokens.length > 1) return { error: `Expected a single scope argument (got: ${tokens.join(" ")}).` };
	const [token] = tokens;
	if (token !== "global" && token !== "local") {
		return { error: `Unknown scope: ${token}. Expected "global" or "local".` };
	}
	return { scope: token };
}

function scopeToInternal(scope: ToggleScope): TeamConfigScope {
	return scope === "local" ? "project" : "global";
}

function readExistingConfig(path: string): { config: TeamProjectConfigFile; warning?: string } {
	if (!existsSync(path)) {
		return { config: { version: 1 } };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			config: { version: 1 },
			warning: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); writing a fresh file with only the enabled flag set.`,
		};
	}
	const errors = Array.from(Value.Errors(TeamProjectConfigSchema, raw));
	if (errors.length > 0) {
		return {
			config: { version: 1 },
			warning: `${path} failed schema validation (${errors[0]?.message ?? "unknown error"}); writing a fresh file with only the enabled flag set.`,
		};
	}
	return { config: raw as TeamProjectConfigFile };
}

function writeConfig(path: string, config: TeamProjectConfigFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function runToggle(args: string, desiredEnabled: boolean, ctx: ExtensionContext, dependencies: ToggleCommandDependencies): void {
	const parsed = parseToggleArgs(args);
	if (parsed.error) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}
	if (!parsed.scope) {
		const verb = desiredEnabled ? "team-enable" : "team-disable";
		ctx.ui.notify(`Usage: /${verb} global|local`, "warning");
		return;
	}

	const internalScope = scopeToInternal(parsed.scope);
	const targetPath = getProjectConfigPathForScope(internalScope, ctx.cwd);
	const { config, warning } = readExistingConfig(targetPath);
	const previousEnabled = config.enabled;
	const nextConfig: TeamProjectConfigFile = { ...config, enabled: desiredEnabled };
	writeConfig(targetPath, nextConfig);

	const lines: string[] = [];
	if (warning) lines.push(warning);
	lines.push(
		`${parsed.scope === "global" ? "Global" : "Local"} agents-team.json: enabled=${previousEnabled === undefined ? "default" : previousEnabled} → ${desiredEnabled} (${targetPath}).`,
		"Run /reload-plugins to apply in this session.",
	);
	dependencies.emitText(ctx, lines.join("\n"));
}

export function registerTeamToggleCommands(pi: ExtensionAPI, dependencies: ToggleCommandDependencies): void {
	pi.registerCommand("team-enable", {
		description: "Enable Pi Agents Team orchestrator logic: /team-enable global|local",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return ["global", "local"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value, description: value === "global" ? "~/.pi/agent/agents-team.json" : "./.pi/agent/agents-team.json" }));
		},
		handler: async (args, ctx) => runToggle(args, true, ctx, dependencies),
	});

	pi.registerCommand("team-disable", {
		description: "Disable Pi Agents Team orchestrator logic: /team-disable global|local",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return ["global", "local"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value, description: value === "global" ? "~/.pi/agent/agents-team.json" : "./.pi/agent/agents-team.json" }));
		},
		handler: async (args, ctx) => runToggle(args, false, ctx, dependencies),
	});
}

export const _testing = { parseToggleArgs, readExistingConfig, writeConfig, scopeToInternal };
