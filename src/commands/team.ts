import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { openTeamDashboardOverlay } from "../ui/overlay";
import type { TeamManager } from "../control-plane/team-manager";

export interface CommandRegistrationContext {
	teamManager: TeamManager;
	emitText: (ctx: ExtensionContext, text: string) => void;
}

export function registerTeamCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team", {
		description: "Open the Pi Agent Team dashboard overlay",
		handler: async (_args, ctx) => {
			await openTeamDashboardOverlay(ctx, dependencies.teamManager.snapshot());
		},
	});
}
