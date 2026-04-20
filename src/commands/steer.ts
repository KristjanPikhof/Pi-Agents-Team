import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandRegistrationContext } from "./team";

export function registerWorkerMessageCommands(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-steer", {
		description: "Steer a running worker: /agent-steer <worker-id> <message>",
		handler: async (args, ctx) => {
			const [workerId, ...messageParts] = args.trim().split(/\s+/);
			if (!workerId || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-steer <worker-id> <message>", "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, messageParts.join(" "), "steer");
			dependencies.emitText(ctx, `Steered ${result.worker.workerId}`);
		},
	});

	pi.registerCommand("agent-followup", {
		description: "Queue follow-up work for an idle worker: /agent-followup <worker-id> <message>",
		handler: async (args, ctx) => {
			const [workerId, ...messageParts] = args.trim().split(/\s+/);
			if (!workerId || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-followup <worker-id> <message>", "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, messageParts.join(" "), "follow_up");
			dependencies.emitText(ctx, `Queued follow-up for ${result.worker.workerId}`);
		},
	});
}
