import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerRuntimeState } from "../types";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

function formatWorkerDetail(worker: WorkerRuntimeState, transcript?: string): string {
	const lines = [
		`Worker: ${worker.workerId}`,
		`Profile: ${worker.profileName}`,
		`Status: ${worker.status}`,
	];
	if (worker.currentTask?.title) lines.push(`Task: ${worker.currentTask.title}`);
	if (worker.currentTask?.goal) lines.push(`Goal: ${worker.currentTask.goal}`);
	if (worker.lastToolName) lines.push(`Last tool: ${worker.lastToolName}`);
	if (worker.error) lines.push(`Error: ${worker.error}`);

	const summary = worker.lastSummary;
	if (summary) {
		if (summary.headline) lines.push(`Headline: ${summary.headline}`);
		if (summary.readFiles.length) lines.push(`Read files: ${summary.readFiles.join(", ")}`);
		if (summary.changedFiles.length) lines.push(`Changed files: ${summary.changedFiles.join(", ")}`);
		if (summary.risks.length) lines.push(`Risks: ${summary.risks.join("; ")}`);
		if (summary.nextRecommendation) lines.push(`Next: ${summary.nextRecommendation}`);
	}

	if (worker.pendingRelayQuestions.length > 0) {
		lines.push("", "Pending relay questions:");
		for (const relay of worker.pendingRelayQuestions) {
			lines.push(`- [${relay.urgency}] ${relay.question}`);
			lines.push(`  assumption: ${relay.assumption}`);
		}
	}

	lines.push(
		"",
		`Usage: turns=${worker.usage.turns} input=${worker.usage.inputTokens} output=${worker.usage.outputTokens} cost=$${worker.usage.costUsd.toFixed(4)}`,
	);

	if (transcript && transcript.trim()) {
		lines.push("", "--- Latest assistant text ---", transcript.trim());
	} else {
		lines.push("", "No assistant text captured yet (worker has not emitted a final message).");
	}

	return lines.join("\n");
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
				ctx.ui.notify("Usage: /team-result <worker-id>", "warning");
				return;
			}
			const resolved = dependencies.teamManager.resolveWorkerId(input);
			const candidates = dependencies.teamManager.listWorkers().map((worker) => worker.workerId);
			if (!resolved) {
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const result = dependencies.teamManager.getWorkerResult(resolved)!;
			const transcript = dependencies.teamManager.getWorkerTranscript(resolved);
			dependencies.emitText(ctx, formatWorkerDetail(result.worker, transcript));
		},
	});
}

export const _testing = { formatWorkerDetail };
