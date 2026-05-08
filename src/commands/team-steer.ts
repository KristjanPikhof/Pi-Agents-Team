import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessageResult } from "../control-plane/team-manager";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

interface ParsedArgs {
	target?: string;
	message?: string;
	queue: boolean;
	error?: string;
}

function parseSteerArgs(raw: string): ParsedArgs {
	if (!raw.trim()) {
		return { queue: false, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}
	// Walk the raw string consuming whitespace + leading "--queue"/target tokens;
	// the remainder is the message body verbatim (preserves embedded whitespace).
	let pos = 0;
	let target: string | undefined;
	let queue = false;
	const skipSpaces = () => {
		while (pos < raw.length && /\s/.test(raw[pos]!)) pos += 1;
	};
	while (pos < raw.length) {
		skipSpaces();
		if (pos >= raw.length) break;
		const start = pos;
		while (pos < raw.length && !/\s/.test(raw[pos]!)) pos += 1;
		const token = raw.slice(start, pos);
		if (token === "--queue") {
			queue = true;
			continue;
		}
		if (!target) {
			target = token;
			continue;
		}
		// First non-flag, non-target token marks the start of the message body.
		pos = start;
		break;
	}
	if (!target) {
		return { queue, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}
	const message = raw.slice(pos).trim();
	if (!message) {
		return { target, queue, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}
	return { target, message, queue };
}

function describeDelivery(result: AgentMessageResult): string {
	const verb =
		result.delivery === "steer"
			? "Steered"
			: result.delivery === "prompt"
				? "Prompted"
				: "Queued follow-up for";
	return `${verb} ${result.worker.workerId} (${result.worker.profileName}:${result.worker.status})`;
}

function formatBroadcast(label: string, results: AgentMessageResult[]): string {
	if (results.length === 0) return `${label}: no deliverable workers (all tracked workers are terminal).`;
	const lines = results.map((result) => `- ${describeDelivery(result)}`);
	return [`${label} ${results.length} worker(s):`, ...lines].join("\n");
}

export function registerTeamSteerCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-steer", {
		description: "Send a message to one or all workers: /team-steer <worker-id|all> [--queue] <message>. Default routes by status (steer for running, prompt to wake idle/waiting). --queue forces follow_up delivery for streaming workers; idle/waiting workers still upgrade to a fresh prompt so the session wakes.",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			const completions = [] as { value: string; label: string; description: string }[];
			if ("all".startsWith(prefix)) {
				completions.push({
					value: "all",
					label: "all",
					description: "broadcast to every deliverable worker",
				});
			}
			if ("--queue".startsWith(prefix)) {
				completions.push({
					value: "--queue",
					label: "--queue",
					description: "force follow_up delivery for streaming workers",
				});
			}
			for (const worker of dependencies.teamManager.listWorkers()) {
				if (!worker.workerId.startsWith(prefix)) continue;
				completions.push({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
				});
			}
			return completions;
		},
		handler: async (args, ctx) => {
			const parsed = parseSteerArgs(args);
			if (parsed.error || !parsed.target || !parsed.message) {
				ctx.ui.notify(parsed.error ?? "Usage: /team-steer <worker-id|all> [--queue] <message>", "warning");
				return;
			}
			const delivery = parsed.queue ? "follow_up" : "auto";

			if (parsed.target.toLowerCase() === "all") {
				const results = await dependencies.teamManager.messageAllWorkers(parsed.message, delivery);
				const label = parsed.queue ? "Queued follow-up for" : "Broadcast routed to";
				dependencies.emitText(ctx, formatBroadcast(label, results));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(parsed.target);
			if (!workerId) {
				const candidates = ["all", ...dependencies.teamManager.listWorkers().map((worker) => worker.workerId)];
				ctx.ui.notify(formatUnknownWorker(parsed.target, suggestTargets(parsed.target, candidates)), "warning");
				return;
			}
			try {
				const result = await dependencies.teamManager.messageWorker(workerId, parsed.message, delivery);
				dependencies.emitText(ctx, describeDelivery(result));
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}

export const _testing = { parseSteerArgs };
