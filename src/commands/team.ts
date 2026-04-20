import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { openTeamDashboardOverlay } from "../ui/overlay";
import type { TeamManager } from "../control-plane/team-manager";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";

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
			if (!input) {
				await openTeamDashboardOverlay(ctx, dependencies.teamManager);
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				const candidates = dependencies.teamManager.listWorkers().map((worker) => worker.workerId);
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			await openTeamDashboardOverlay(ctx, dependencies.teamManager, { initialWorkerId: workerId });
		},
	});
}
