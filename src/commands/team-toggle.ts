import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { TeamProjectConfigSchema } from "../config";
import { getProjectConfigPathForScope } from "../project-config/loader";
import { atomicWriteFileSync, backupExisting } from "../util/backup";
import { TEAM_PROJECT_SCHEMA_VERSION, type TeamConfigScope, type TeamProjectConfigFile } from "../types";

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

type ExistingConfigReadResult =
	| { kind: "missing" }
	| { kind: "valid"; config: TeamProjectConfigFile }
	| { kind: "parsed_but_drift"; raw: Record<string, unknown>; schemaError: string }
	| { kind: "unparsable"; error: string };

function readExistingConfig(path: string): ExistingConfigReadResult {
	if (!existsSync(path)) return { kind: "missing" };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { kind: "unparsable", error: error instanceof Error ? error.message : String(error) };
	}
	const errors = Array.from(Value.Errors(TeamProjectConfigSchema, raw));
	if (errors.length > 0) {
		// File parsed as JSON but failed schema validation. Preserve the user's
		// raw object (so their roles/prompts/tools don't get deleted) and let the
		// toggle handler patch `enabled` onto it. The file will still be
		// schema-invalid next load, but at least nothing was destroyed.
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			return {
				kind: "parsed_but_drift",
				raw: raw as Record<string, unknown>,
				schemaError: errors[0]?.message ?? "unknown schema error",
			};
		}
		return { kind: "unparsable", error: `top-level value is not an object (${errors[0]?.message ?? "unknown error"})` };
	}
	return { kind: "valid", config: raw as TeamProjectConfigFile };
}

function writeConfig(path: string, config: TeamProjectConfigFile): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function writeRawConfig(path: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
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
	const existing = readExistingConfig(targetPath);

	const lines: string[] = [];
	let previousEnabled: boolean | "default" = "default";

	switch (existing.kind) {
		case "missing": {
			// Fresh write — no destruction risk.
			writeConfig(targetPath, { schemaVersion: TEAM_PROJECT_SCHEMA_VERSION, enabled: desiredEnabled });
			break;
		}
		case "valid": {
			// Happy path — patch enabled in place.
			previousEnabled = existing.config.enabled ?? "default";
			writeConfig(targetPath, { ...existing.config, enabled: desiredEnabled });
			break;
		}
		case "parsed_but_drift": {
			// File parses as JSON but drifts from our schema (old shape, future
			// field, hand-edited oddity). PRESERVE the user's content — only patch
			// the `enabled` field on the raw object. The next session_start will
			// emit the same schema-mismatch warning the loader already produces; we
			// don't quietly "fix" things we don't understand.
			previousEnabled = typeof existing.raw.enabled === "boolean" ? (existing.raw.enabled as boolean) : "default";
			writeRawConfig(targetPath, { ...existing.raw, enabled: desiredEnabled });
			lines.push(
				`Warning: ${targetPath} does not match the current schema (${existing.schemaError}). The \`enabled\` flag was updated but the rest of the file was left untouched — fix the schema or run \`/team-init ${parsed.scope} --force\` to regenerate (the old file will be backed up).`,
			);
			break;
		}
		case "unparsable": {
			// Cannot safely patch. Back the file up first so nothing is lost, then
			// write a minimal replacement with just the enabled flag.
			const backupPath = backupExisting(targetPath);
			writeConfig(targetPath, { schemaVersion: TEAM_PROJECT_SCHEMA_VERSION, enabled: desiredEnabled });
			lines.push(
				`Warning: ${targetPath} was unparsable (${existing.error}). The previous file was backed up to ${backupPath} and a minimal replacement with only the enabled flag was written.`,
			);
			break;
		}
	}

	lines.push(
		`${parsed.scope === "global" ? "Global" : "Local"} agents-team.json: enabled=${previousEnabled} → ${desiredEnabled} (${targetPath}).`,
		"Run /reload to apply in this session.",
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

export const _testing = { parseToggleArgs, readExistingConfig, writeConfig, writeRawConfig, scopeToInternal };
