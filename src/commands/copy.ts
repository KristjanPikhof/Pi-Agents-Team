import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCopyPayload } from "../ui/copy-payload";
import { copyToClipboard } from "../util/clipboard";
import type { CommandRegistrationContext } from "./team";

export function registerCopyCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-copy", {
		description: "Copy a worker's task, summary, final answer, transcript, and console to the clipboard: /team-copy <worker-id>",
		getArgumentCompletions: (prefix) => {
			const token = prefix.split(/\s+/)[0] ?? "";
			return dependencies.teamManager
				.listWorkers()
				.filter((worker) => worker.workerId.startsWith(token))
				.map((worker) => ({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}`,
				}));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /team-copy <worker-id>", "warning");
				return;
			}
			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				ctx.ui.notify(`Unknown worker: ${input}`, "warning");
				return;
			}
			const result = dependencies.teamManager.getWorkerResult(workerId);
			if (!result) {
				ctx.ui.notify(`Unknown worker: ${input}`, "warning");
				return;
			}
			const payload = buildCopyPayload(
				result.worker,
				dependencies.teamManager.getWorkerTranscript(workerId),
				dependencies.teamManager.getWorkerConsole(workerId),
			);
			try {
				await copyToClipboard(payload);
				dependencies.emitText(ctx, `Copied ${workerId} (${payload.length.toLocaleString()} chars) to clipboard.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Copy failed: ${message}`, "warning");
			}
		},
	});
}
