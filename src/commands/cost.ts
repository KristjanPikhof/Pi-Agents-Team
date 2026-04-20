import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandRegistrationContext } from "./team";

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

export function registerCostCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-cost", {
		description: "Show per-worker usage and the aggregate token + cost totals for the agent team.",
		handler: async (_args, ctx) => {
			const workers = dependencies.teamManager.listWorkers();
			if (workers.length === 0) {
				dependencies.emitText(ctx, "No tracked workers. The orchestrator's own usage is shown in the Pi footer.");
				return;
			}
			const rows = workers.map((worker) => {
				const u = worker.usage;
				return `${worker.workerId.padEnd(5)} ${worker.profileName.padEnd(10)} status=${worker.status.padEnd(8)} turns=${String(u.turns).padStart(3)}  in=${formatNumber(u.inputTokens).padStart(8)}  out=${formatNumber(u.outputTokens).padStart(6)}  cache=${formatNumber(u.cacheReadTokens)}r/${formatNumber(u.cacheWriteTokens)}w  cost=${formatCost(u.costUsd)}`;
			});
			const totals = dependencies.teamManager.aggregateUsage();
			const lines = [
				`Agent team usage (${totals.workers} worker${totals.workers === 1 ? "" : "s"}):`,
				...rows,
				"",
				`Σ turns=${formatNumber(totals.turns)}  in=${formatNumber(totals.inputTokens)}  out=${formatNumber(totals.outputTokens)}  cache=${formatNumber(totals.cacheReadTokens)}r/${formatNumber(totals.cacheWriteTokens)}w  cost=${formatCost(totals.costUsd)}`,
				"Orchestrator usage is shown in the Pi footer (↑ input ↓ output $cost).",
			];
			dependencies.emitText(ctx, lines.join("\n"));
		},
	});
}
