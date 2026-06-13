import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCommandWarning } from "../ui/display-grammar";
import { formatWorkerDetail as formatSharedWorkerDetail } from "../ui/tool-formatters";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

function stripFinalAnswerBlocks(transcript?: string): string | undefined {
	const sanitized = transcript?.replace(/<final_answer>[\s\S]*?<\/final_answer>/gi, "").trim();
	return sanitized || undefined;
}

function formatWorkerDetail(worker: Parameters<typeof formatSharedWorkerDetail>[0], transcript?: string): string {
	return formatSharedWorkerDetail(worker, { transcript: stripFinalAnswerBlocks(transcript), compactUsage: true });
}

export function registerTeamResultCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-result", {
		description: "Show the full result for a worker: /team-result <worker-id>",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return dependencies.teamManager
				.listWorkers()
				.filter((worker) => worker.workerId.startsWith(prefix))
				.map((worker) => ({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}${worker.currentTask?.title ? ` · ${worker.currentTask.title}` : ""}`,
				}));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(formatCommandWarning("Usage: /team-result <worker-id>"), "warning");
				return;
			}
			const resolved = dependencies.teamManager.resolveWorkerId(input);
			const candidates = dependencies.teamManager.listWorkers().map((worker) => worker.workerId);
			if (!resolved) {
				ctx.ui.notify(formatCommandWarning(formatUnknownWorker(input, suggestTargets(input, candidates))), "warning");
				return;
			}
			const result = dependencies.teamManager.getWorkerResult(resolved)!;
			const transcript = dependencies.teamManager.getWorkerTranscript(resolved);
			dependencies.emitText(ctx, formatWorkerDetail(result.worker, transcript));
		},
	});
}

export const _testing = { formatWorkerDetail };
