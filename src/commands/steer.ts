import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandRegistrationContext } from "./team";

function completeWorkerIds(teamManager: CommandRegistrationContext["teamManager"], prefix: string) {
	const token = prefix.split(/\s+/)[0] ?? "";
	return teamManager
		.listWorkers()
		.filter((worker) => worker.workerId.startsWith(token))
		.map((worker) => ({
			value: worker.workerId,
			label: worker.workerId,
			description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
		}));
}

export function registerWorkerMessageCommands(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-steer", {
		description: "Steer a running worker: /agent-steer <worker-id> <message>",
		getArgumentCompletions: (prefix) => completeWorkerIds(dependencies.teamManager, prefix),
		handler: async (args, ctx) => {
			const [rawId, ...messageParts] = args.trim().split(/\s+/);
			if (!rawId || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-steer <worker-id> <message>", "warning");
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(rawId);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${rawId}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, messageParts.join(" "), "steer");
			dependencies.emitText(ctx, `Steered ${result.worker.workerId}`);
		},
	});

	pi.registerCommand("agent-followup", {
		description: "Queue follow-up work for an idle worker: /agent-followup <worker-id> <message>",
		getArgumentCompletions: (prefix) => completeWorkerIds(dependencies.teamManager, prefix),
		handler: async (args, ctx) => {
			const [rawId, ...messageParts] = args.trim().split(/\s+/);
			if (!rawId || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-followup <worker-id> <message>", "warning");
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(rawId);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${rawId}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, messageParts.join(" "), "follow_up");
			dependencies.emitText(ctx, `Queued follow-up for ${result.worker.workerId}`);
		},
	});
}
