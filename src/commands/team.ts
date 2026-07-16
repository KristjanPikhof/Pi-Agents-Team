import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openTeamDashboardOverlay } from "../ui/overlay.js";
import { buildTeamDashboardText } from "../ui/dashboard.js";
import { formatCommandWarning } from "../ui/display-grammar.js";
import type { TeamManager } from "../control-plane/team-manager.js";
import { formatUnknownWorker, suggestTargets } from "../util/suggest.js";

export interface CommandRegistrationContext {
	teamManager: TeamManager;
	emitText: (ctx: ExtensionContext, text: string) => void;
}

export function registerTeamCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team", {
		description: "Open the Pi Agents Team dashboard: /team or /team <worker-id>",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return dependencies.teamManager
				.listWorkers()
				.filter((worker) => worker.workerId.startsWith(prefix))
				.map((worker) => ({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
				}));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const emitDashboardText = async () => {
				await dependencies.teamManager.pingWorkers({ mode: "active" }).catch(() => {});
				dependencies.emitText(ctx, buildTeamDashboardText(dependencies.teamManager.snapshot(), {
					displayCost: dependencies.teamManager.displayCost,
				}));
			};
			if (!input) {
				if (ctx.mode === "tui") await openTeamDashboardOverlay(ctx, dependencies.teamManager);
				else await emitDashboardText();
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				const candidates = dependencies.teamManager.listWorkers().map((worker) => worker.workerId);
				const warning = formatCommandWarning(formatUnknownWorker(input, suggestTargets(input, candidates)));
				if (ctx.mode === "tui") ctx.ui.notify(warning, "warning");
				else dependencies.emitText(ctx, warning);
				return;
			}
			if (ctx.mode === "tui") await openTeamDashboardOverlay(ctx, dependencies.teamManager, { initialWorkerId: workerId });
			else await emitDashboardText();
		},
	});
}
