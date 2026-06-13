import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCopyPayload } from "../ui/copy-payload";
import { formatCommandWarning } from "../ui/display-grammar";
import { copyToClipboard } from "../util/clipboard";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

export function registerCopyCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-copy", {
		description: "Copy a worker's task, summary, final answer, transcript, and console to the clipboard: /team-copy <worker-id>",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			return dependencies.teamManager
				.listWorkers()
				.filter((worker) => worker.workerId.startsWith(prefix))
				.map((worker) => ({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}`,
				}));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(formatCommandWarning("Usage: /team-copy <worker-id>"), "warning");
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(input);
			const candidates = dependencies.teamManager.listWorkers().map((worker) => worker.workerId);
			if (!workerId) {
				ctx.ui.notify(formatCommandWarning(formatUnknownWorker(input, suggestTargets(input, candidates))), "warning");
				return;
			}
			const result = dependencies.teamManager.getWorkerResult(workerId);
			if (!result) {
				ctx.ui.notify(formatCommandWarning(formatUnknownWorker(input, suggestTargets(input, candidates))), "warning");
				return;
			}
			const payload = buildCopyPayload(
				result.worker,
				dependencies.teamManager.getWorkerTranscript(workerId),
				dependencies.teamManager.getWorkerConsole(workerId),
			);
			try {
				await copyToClipboard(payload);
				ctx.ui.notify(`Copy complete — ${workerId} (${payload.length.toLocaleString()} chars)`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(formatCommandWarning(`Copy failed — ${message}`), "warning");
			}
		},
	});
}
