import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessageResult } from "../control-plane/team-manager";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

function unknownTargetMessage(teamManager: CommandRegistrationContext["teamManager"], input: string): string {
	const candidates = ["all", ...teamManager.listWorkers().map((worker) => worker.workerId)];
	return formatUnknownWorker(input, suggestTargets(input, candidates));
}

function completeWorkerTargets(teamManager: CommandRegistrationContext["teamManager"], prefix: string) {
	if (/\s/.test(prefix)) return [];
	const completions = [] as { value: string; label: string; description: string }[];
	if ("all".startsWith(prefix)) {
		completions.push({
			value: "all",
			label: "all",
			description: "broadcast to every tracked worker",
		});
	}
	for (const worker of teamManager.listWorkers()) {
		if (!worker.workerId.startsWith(prefix)) continue;
		completions.push({
			value: worker.workerId,
			label: worker.workerId,
			description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
		});
	}
	return completions;
}

function describeDelivery(result: AgentMessageResult): string {
	const verb = result.delivery === "steer" ? "Steered" : "Queued follow-up for";
	return `${verb} ${result.worker.workerId} (${result.worker.profileName}:${result.worker.status})`;
}

function formatBroadcast(label: string, results: AgentMessageResult[]): string {
	if (results.length === 0) return `${label}: no deliverable workers (all tracked workers are terminal).`;
	const lines = results.map((result) => `- ${describeDelivery(result)}`);
	return [`${label} ${results.length} worker(s):`, ...lines].join("\n");
}

export function registerWorkerMessageCommands(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("agent-steer", {
		description: "Send a message to one or all workers: /agent-steer <worker-id|all> <message>",
		getArgumentCompletions: (prefix) => completeWorkerTargets(dependencies.teamManager, prefix),
		handler: async (args, ctx) => {
			const [rawTarget, ...messageParts] = args.trim().split(/\s+/);
			if (!rawTarget || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-steer <worker-id|all> <message>", "warning");
				return;
			}
			const message = messageParts.join(" ");

			if (rawTarget.toLowerCase() === "all") {
				const results = await dependencies.teamManager.messageAllWorkers(message, "auto");
				dependencies.emitText(ctx, formatBroadcast("Broadcast routed to", results));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(rawTarget);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${rawTarget}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, message, "auto");
			dependencies.emitText(ctx, describeDelivery(result));
		},
	});

	pi.registerCommand("agent-followup", {
		description: "Queue a follow-up for one or all idle workers: /agent-followup <worker-id|all> <message>",
		getArgumentCompletions: (prefix) => completeWorkerTargets(dependencies.teamManager, prefix),
		handler: async (args, ctx) => {
			const [rawTarget, ...messageParts] = args.trim().split(/\s+/);
			if (!rawTarget || messageParts.length === 0) {
				ctx.ui.notify("Usage: /agent-followup <worker-id|all> <message>", "warning");
				return;
			}
			const message = messageParts.join(" ");

			if (rawTarget.toLowerCase() === "all") {
				const results = await dependencies.teamManager.messageAllWorkers(message, "follow_up");
				dependencies.emitText(ctx, formatBroadcast("Queued follow-up for", results));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(rawTarget);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${rawTarget}`, "warning");
				return;
			}
			const result = await dependencies.teamManager.messageWorker(workerId, message, "follow_up");
			dependencies.emitText(ctx, describeDelivery(result));
		},
	});
}
