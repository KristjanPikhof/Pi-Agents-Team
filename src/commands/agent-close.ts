import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

export function registerAgentCloseCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-close", {
		description: "Dispose an idle/waiting_followup worker's RPC session: /agent-close <worker-id|all>",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			const completions = [] as { value: string; label: string; description: string }[];
			if ("all".startsWith(prefix)) {
				completions.push({
					value: "all",
					label: "all",
					description: "close every idle/waiting_followup worker",
				});
			}
			for (const worker of dependencies.teamManager.listWorkers()) {
				if (!worker.workerId.startsWith(prefix)) continue;
				if (worker.status !== "idle" && worker.status !== "waiting_followup") continue;
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
				ctx.ui.notify("Usage: /agent-close <worker-id|all>", "warning");
				return;
			}

			if (input.toLowerCase() === "all") {
				const reusable = dependencies.teamManager
					.listWorkers()
					.filter((worker) => worker.status === "idle" || worker.status === "waiting_followup");
				if (reusable.length === 0) {
					dependencies.emitText(ctx, "No idle/waiting_followup workers to close.");
					return;
				}
				const results = await dependencies.teamManager.closeAllWorkers();
				const lines = results.map(
					(result) => `- ${result.worker.workerId} (${result.worker.profileName}) → ${result.worker.status}`,
				);
				dependencies.emitText(ctx, [`Closed ${results.length} worker(s):`, ...lines].join("\n"));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				const candidates = ["all", ...dependencies.teamManager.listWorkers().map((worker) => worker.workerId)];
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const worker = dependencies.teamManager.getWorkerStatus(workerId);
			if (worker && worker.status !== "idle" && worker.status !== "waiting_followup") {
				const hint = worker.status === "running" || worker.status === "starting"
					? "Worker is still running — use /agent-cancel first."
					: `Worker is ${worker.status}; nothing to close. Use /team-prune to clear it from the dashboard.`;
				ctx.ui.notify(hint, "warning");
				return;
			}
			const result = await dependencies.teamManager.closeWorker(workerId);
			dependencies.emitText(
				ctx,
				`Closed ${result.worker.workerId} (${result.worker.profileName}) → status=${result.worker.status}`,
			);
		},
	});
}
