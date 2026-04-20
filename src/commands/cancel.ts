import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandRegistrationContext } from "./team";

export function registerCancelCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-cancel", {
		description: "Cancel a worker: /agent-cancel <worker-id>",
		getArgumentCompletions: (prefix) => dependencies.teamManager
			.listWorkers()
			.filter((worker) => worker.workerId.startsWith(prefix))
			.map((worker) => ({
				value: worker.workerId,
				label: worker.workerId,
				description: `${worker.profileName} · ${worker.status}`,
			})),
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /agent-cancel <worker-id>", "warning");
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${input}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.cancelWorker(workerId);
			dependencies.emitText(ctx, `Cancelled ${result.worker.workerId}`);
		},
	});
}
