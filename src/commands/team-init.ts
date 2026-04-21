import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backupExisting, formatBackupTimestamp } from "../util/backup";
import { CURRENT_SCAFFOLD_VERSION, DEFAULT_TEAM_CONFIG } from "../config";
import { getProjectConfigPathForScope } from "../project-config/loader";
import {
	DEFAULT_MODEL_SENTINEL,
	DEFAULT_PROMPT_SENTINEL,
	TEAM_PROJECT_SCHEMA_VERSION,
	type PartialRawProjectRoleConfigMap,
	type ProjectRoleFlatConfig,
	type TeamConfigScope,
	type TeamProfileSpec,
	type TeamProjectConfigFile,
} from "../types";

interface InitCommandDependencies {
	emitText: (ctx: ExtensionContext, text: string) => void;
}

type InitScope = "global" | "local";

function parseInitArgs(args: string): { scope?: InitScope; force: boolean; error?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let scope: InitScope | undefined;
	let force = false;
	for (const token of tokens) {
		if (token === "--force" || token === "-f") {
			force = true;
			continue;
		}
		if (token === "global" || token === "local") {
			if (scope) {
				return { force, error: `Specify the scope only once (got "${scope}" and "${token}").` };
			}
			scope = token;
			continue;
		}
		return { force, error: `Unknown argument: ${token}. Expected "global", "local", or --force.` };
	}
	return { scope, force };
}

function scaffoldRole(profile: TeamProfileSpec): ProjectRoleFlatConfig {
	const role: ProjectRoleFlatConfig = {
		whenToUse: profile.description,
		model: DEFAULT_MODEL_SENTINEL,
		thinkingLevel: profile.thinkingLevel,
		tools: [...profile.tools],
		write: profile.writePolicy === "scoped-write",
		prompt: DEFAULT_PROMPT_SENTINEL,
	};
	return role;
}

function buildFullScaffold(): TeamProjectConfigFile {
	const roles: PartialRawProjectRoleConfigMap = {};
	for (const profile of DEFAULT_TEAM_CONFIG.profiles) {
		roles[profile.name] = scaffoldRole(profile);
	}
	return {
		schemaVersion: TEAM_PROJECT_SCHEMA_VERSION,
		scaffoldVersion: CURRENT_SCAFFOLD_VERSION,
		enabled: true,
		roles,
	};
}

function scopeToInternal(scope: InitScope): TeamConfigScope {
	return scope === "local" ? "project" : "global";
}

export function registerTeamInitCommand(pi: ExtensionAPI, dependencies: InitCommandDependencies): void {
	pi.registerCommand("team-init", {
		description: "Scaffold a full agents-team.json with default roles: /team-init global|local [--force]",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return ["global", "local"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value, description: value === "global" ? "~/.pi/agent/agents-team.json" : "./.pi/agent/agents-team.json" }));
		},
		handler: async (args, ctx) => {
			const parsed = parseInitArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			if (!parsed.scope) {
				ctx.ui.notify("Usage: /team-init global|local [--force]", "warning");
				return;
			}

			const internalScope = scopeToInternal(parsed.scope);
			const targetPath = getProjectConfigPathForScope(internalScope, ctx.cwd);
			const exists = existsSync(targetPath);

			if (exists && !parsed.force) {
				dependencies.emitText(
					ctx,
					`${targetPath} already exists. Re-run with \`/team-init ${parsed.scope} --force\` to overwrite (the current file will be backed up first).`,
				);
				return;
			}

			mkdirSync(dirname(targetPath), { recursive: true });
			let backupPath: string | undefined;
			if (exists) {
				backupPath = backupExisting(targetPath);
			}
			writeFileSync(targetPath, `${JSON.stringify(buildFullScaffold(), null, 2)}\n`);

			const lines: string[] = [];
			if (backupPath) {
				lines.push(`Backed up previous config to ${backupPath}.`);
			}
			lines.push(
				`Wrote ${parsed.scope} agents-team.json scaffold (schemaVersion ${TEAM_PROJECT_SCHEMA_VERSION}, scaffoldVersion ${CURRENT_SCAFFOLD_VERSION}) to ${targetPath}.`,
				`Per-role knobs: whenToUse (a trigger sentence — "Use when..." — shown to the orchestrator so it picks the right role), model (${DEFAULT_MODEL_SENTINEL} = inherit orchestrator, or "provider/model-id"), thinkingLevel, tools (the role's tool set), write (true/false — writable roles need an explicit pathScope at delegate time), prompt (${DEFAULT_PROMPT_SENTINEL} = built-in, or a path to your own .md, or the prompt text inline).`,
				"Rename, remove, or add roles freely — the orchestrator sees exactly what you declare. Delete a role block to fall back to the built-in defaults for that name.",
				"Run /reload to apply changes in this session.",
			);
			dependencies.emitText(ctx, lines.join("\n"));
		},
	});
}

export const _testing = { parseInitArgs, buildFullScaffold, scaffoldRole, scopeToInternal, formatBackupTimestamp, backupExisting };
