import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isTerminalWorkerStatus } from "../control-plane/team-manager";
import type { CommandRegistrationContext } from "./team";

export function registerCancelCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-cancel", {
		description: "Cancel one or all workers: /agent-cancel <worker-id|all>",
		getArgumentCompletions: (prefix) => {
			const completions = [] as { value: string; label: string; description: string }[];
			if ("all".startsWith(prefix)) {
				completions.push({
					value: "all",
					label: "all",
					description: "abort every non-terminal worker",
				});
			}
			for (const worker of dependencies.teamManager.listWorkers()) {
				if (!worker.workerId.startsWith(prefix)) continue;
				completions.push({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}`,
				});
			}
			return completions;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /agent-cancel <worker-id|all>", "warning");
				return;
			}

			if (input.toLowerCase() === "all") {
				const live = dependencies.teamManager.listWorkers().filter((worker) => !isTerminalWorkerStatus(worker.status));
				if (live.length === 0) {
					dependencies.emitText(ctx, "No live workers to cancel (all tracked workers are already terminal).");
					return;
				}
				const results = await dependencies.teamManager.cancelAllWorkers();
				const lines = results.map((result) => `- ${result.worker.workerId} (${result.worker.profileName}) → ${result.worker.status}`);
				dependencies.emitText(ctx, [`Cancelled ${results.length} worker(s):`, ...lines].join("\n"));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${input}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.cancelWorker(workerId);
			dependencies.emitText(ctx, `Cancelled ${result.worker.workerId} (${result.worker.profileName}) → status=${result.worker.status}`);
		},
	});
}
