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
	const trimmed = raw.trimStart();
	if (!trimmed) {
		return { queue: false, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}
	const tokens = trimmed.split(/\s+/);
	let target: string | undefined;
	let queue = false;
	let messageStartIndex: number | undefined;
	let cursor = 0;
	// Whitespace-skipping char index walk so we can extract the message verbatim
	// once we've consumed the leading flags/target.
	let charIndex = 0;
	const advanceCharIndex = (until: number): void => {
		// Skip whitespace, then skip the next token, then skip following whitespace.
		while (charIndex < raw.length && /\s/.test(raw[charIndex]!)) charIndex += 1;
		const start = charIndex;
		while (charIndex < raw.length && !/\s/.test(raw[charIndex]!)) charIndex += 1;
		messageStartIndex = until;
	};
	for (cursor = 0; cursor < tokens.length; cursor += 1) {
		const token = tokens[cursor]!;
		if (token === "--queue") {
			queue = true;
			continue;
		}
		if (!target) {
			target = token;
			continue;
		}
		// First non-flag token after target marks the start of the message.
		break;
	}
	if (!target) {
		return { queue, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}

	// Reconstruct the message: walk raw left-to-right consuming whitespace and
	// the tokens we've already accepted as flags/target, leaving everything
	// else as the message body verbatim.
	let pos = 0;
	let consumed = 0;
	const consumedTokens: string[] = [];
	for (let i = 0; i < cursor; i += 1) consumedTokens.push(tokens[i]!);
	for (const token of consumedTokens) {
		while (pos < raw.length && /\s/.test(raw[pos]!)) pos += 1;
		if (raw.slice(pos, pos + token.length) === token) {
			pos += token.length;
		}
		consumed += 1;
	}
	while (pos < raw.length && /\s/.test(raw[pos]!)) pos += 1;
	const message = raw.slice(pos);
	if (!message.trim()) {
		return { target, queue, error: "Usage: /team-steer <worker-id|all> [--queue] <message>" };
	}
	void advanceCharIndex;
	void messageStartIndex;
	void consumed;
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
