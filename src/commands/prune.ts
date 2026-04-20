import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isTerminalWorkerStatus } from "../control-plane/team-manager";
import type { CommandRegistrationContext } from "./team";

export function registerPruneCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-prune", {
		description: "Remove every terminal worker (idle/completed/aborted/error/exited) from the dashboard.",
		handler: async (_args, ctx) => {
			const terminal = dependencies.teamManager.listWorkers().filter((worker) => isTerminalWorkerStatus(worker.status));
			if (terminal.length === 0) {
				dependencies.emitText(ctx, "Nothing to prune — all tracked workers are still active.");
				return;
			}
			const removed = dependencies.teamManager.pruneTerminalWorkers();
			const lines = removed.map((worker) => `- ${worker.workerId} (${worker.profileName}) · ${worker.status}`);
			dependencies.emitText(ctx, [`Pruned ${removed.length} terminal worker(s):`, ...lines].join("\n"));
		},
	});
}
