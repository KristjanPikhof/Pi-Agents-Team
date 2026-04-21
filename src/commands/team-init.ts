import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getProjectConfigPathForScope } from "../project-config/loader";
import type { TeamConfigScope, TeamProjectConfigFile } from "../types";

interface InitCommandDependencies {
	emitText: (ctx: ExtensionContext, text: string) => void;
}

const SCOPE_VALUES: TeamConfigScope[] = ["global", "local"] as any;
// "local" is an alias for "project" in user-facing commands.

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

function buildSkeleton(): TeamProjectConfigFile {
	return {
		version: 1,
		enabled: true,
		roles: {},
	};
}

function scopeToInternal(scope: InitScope): TeamConfigScope {
	return scope === "local" ? "project" : "global";
}

export function registerTeamInitCommand(pi: ExtensionAPI, dependencies: InitCommandDependencies): void {
	pi.registerCommand("team-init", {
		description: "Create an agents-team.json skeleton: /team-init global|local [--force]",
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

			if (existsSync(targetPath) && !parsed.force) {
				dependencies.emitText(
					ctx,
					`${targetPath} already exists. Re-run with \`/team-init ${parsed.scope} --force\` to overwrite.`,
				);
				return;
			}

			mkdirSync(dirname(targetPath), { recursive: true });
			writeFileSync(targetPath, `${JSON.stringify(buildSkeleton(), null, 2)}\n`);

			const lines = [
				`Wrote ${parsed.scope} agents-team.json skeleton to ${targetPath}.`,
				"Edit the file to override roles, set enabled=false to disable, or add skill defaults.",
				"Run /reload-plugins to apply changes in this session.",
			];
			dependencies.emitText(ctx, lines.join("\n"));
		},
	});
}

export const _testing = { parseInitArgs, buildSkeleton, scopeToInternal, SCOPE_VALUES };
