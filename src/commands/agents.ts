import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatPingSnapshot } from "../comms/ping";
import type { TeamManager } from "../control-plane/team-manager";
import type { CommandRegistrationContext } from "./team";

function emitWorkers(ctx: ExtensionContext, emitText: CommandRegistrationContext["emitText"], lines: string[]): void {
	emitText(ctx, lines.length > 0 ? lines.join("\n") : "No tracked workers.");
}

export function registerAgentCommands(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agents", {
		description: "List tracked workers",
		handler: async (_args, ctx) => {
			emitWorkers(
				ctx,
				dependencies.emitText,
				dependencies.teamManager.listWorkers().map((worker) => `${worker.workerId} · ${worker.profileName} · ${worker.status}`),
			);
		},
	});

	pi.registerCommand("ping-agents", {
		description: "Ping tracked workers: /ping-agents [active]",
		handler: async (args, ctx) => {
			const mode = args.trim() === "active" ? "active" : "passive";
			const results = await dependencies.teamManager.pingWorkers({ mode });
			emitWorkers(
				ctx,
				dependencies.emitText,
				results.map((result) => formatPingSnapshot({
					workerId: result.worker.workerId,
					profileName: result.worker.profileName,
					status: result.worker.status,
					taskTitle: result.worker.currentTask?.title,
					lastToolName: result.worker.lastToolName,
					lastSummary: result.worker.lastSummary?.headline,
					relayQuestions: result.worker.pendingRelayQuestions,
					lastEventAt: result.worker.lastEventAt,
					usage: result.worker.usage,
				})),
			);
		},
	});
}
