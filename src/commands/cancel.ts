import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandRegistrationContext } from "./team";

export function registerCancelCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-cancel", {
		description: "Cancel a worker: /agent-cancel <worker-id>",
		handler: async (args, ctx) => {
			const workerId = args.trim();
			if (!workerId) {
				ctx.ui.notify("Usage: /agent-cancel <worker-id>", "warning");
				return;
			}
			const result = await dependencies.teamManager.cancelWorker(workerId);
			dependencies.emitText(ctx, `Cancelled ${result.worker.workerId}`);
		},
	});
}
