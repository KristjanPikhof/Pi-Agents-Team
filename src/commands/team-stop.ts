import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerRuntimeState, WorkerStatus } from "../types";
import { formatUnknownWorker, suggestTargets } from "../util/suggest";
import type { CommandRegistrationContext } from "./team";

const UNREACHABLE_TERMINAL: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
	"completed",
	"aborted",
	"error",
	"exited",
]);

type StopResult =
	| { kind: "cancel"; workerId: string; profileName: string; previousStatus: WorkerStatus; nextStatus: WorkerStatus }
	| { kind: "close"; workerId: string; profileName: string; previousStatus: WorkerStatus; nextStatus: WorkerStatus }
	| { kind: "refuse"; workerId: string; status: WorkerStatus; reason: string }
	| { kind: "error"; workerId: string; profileName?: string; previousStatus?: WorkerStatus; message: string };

function describe(result: StopResult): string {
	switch (result.kind) {
		case "cancel":
			return `Worker ${result.workerId} (${result.profileName}): cancel → ${result.nextStatus}`;
		case "close":
			return `Worker ${result.workerId} (${result.profileName}): close → ${result.nextStatus}`;
		case "refuse":
			return `Worker ${result.workerId}: already ${result.status}; nothing to stop.`;
		case "error":
			return `Worker ${result.workerId}: error — ${result.message}`;
	}
}

async function stopOne(
	dependencies: CommandRegistrationContext,
	worker: WorkerRuntimeState,
): Promise<StopResult> {
	const previousStatus = worker.status;
	if (UNREACHABLE_TERMINAL.has(previousStatus)) {
		return { kind: "refuse", workerId: worker.workerId, status: previousStatus, reason: "terminal" };
	}
	try {
		if (previousStatus === "running" || previousStatus === "starting") {
			const result = await dependencies.teamManager.cancelWorker(worker.workerId);
			return {
				kind: "cancel",
				workerId: result.worker.workerId,
				profileName: result.worker.profileName,
				previousStatus,
				nextStatus: result.worker.status,
			};
		}
		if (previousStatus === "idle" || previousStatus === "waiting_followup") {
			const result = await dependencies.teamManager.closeWorker(worker.workerId);
			return {
				kind: "close",
				workerId: result.worker.workerId,
				profileName: result.worker.profileName,
				previousStatus,
				nextStatus: result.worker.status,
			};
		}
		// Defensive — every WorkerStatus is covered above; this branch is for
		// future statuses we don't yet know how to stop.
		return {
			kind: "refuse",
			workerId: worker.workerId,
			status: previousStatus,
			reason: "unknown-status",
		};
	} catch (error) {
		return {
			kind: "error",
			workerId: worker.workerId,
			profileName: worker.profileName,
			previousStatus,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export function registerTeamStopCommand(pi: ExtensionAPI, dependencies: CommandRegistrationContext): void {
	pi.registerCommand("team-stop", {
		description: "Stop a worker: /team-stop <worker-id|all>. Cancels running/starting; closes idle/waiting_followup; refuses already-terminal entries (use /team-prune to clear them).",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return [];
			const completions = [] as { value: string; label: string; description: string }[];
			if ("all".startsWith(prefix)) {
				completions.push({
					value: "all",
					label: "all",
					description: "stop every non-terminal worker (cancel running, close idle)",
				});
			}
			for (const worker of dependencies.teamManager.listWorkers()) {
				if (!worker.workerId.startsWith(prefix)) continue;
				completions.push({
					value: worker.workerId,
					label: worker.workerId,
					description: `${worker.profileName} · ${worker.status}`,
				});
			}
			return completions;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /team-stop <worker-id|all>", "warning");
				return;
			}

			if (input.toLowerCase() === "all") {
				const tracked = dependencies.teamManager.listWorkers();
				if (tracked.length === 0) {
					dependencies.emitText(ctx, "No workers tracked.");
					return;
				}
				const stoppable = tracked.filter((worker) => !isTerminalWorkerStatus(worker.status) || worker.status === "idle" || worker.status === "waiting_followup");
				if (stoppable.length === 0) {
					dependencies.emitText(ctx, "No live or reusable workers to stop (all tracked workers are already terminal).");
					return;
				}
				const results: StopResult[] = [];
				for (const worker of stoppable) {
					results.push(await stopOne(dependencies, worker));
				}
				const lines = results.map((result) => `- ${describe(result)}`);
				dependencies.emitText(ctx, [`Stopped ${results.length} worker(s):`, ...lines].join("\n"));
				return;
			}

			const workerId = dependencies.teamManager.resolveWorkerId(input);
			if (!workerId) {
				const candidates = ["all", ...dependencies.teamManager.listWorkers().map((worker) => worker.workerId)];
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const worker = dependencies.teamManager.getWorkerStatus(workerId);
			if (!worker) {
				const candidates = ["all", ...dependencies.teamManager.listWorkers().map((worker) => worker.workerId)];
				ctx.ui.notify(formatUnknownWorker(input, suggestTargets(input, candidates)), "warning");
				return;
			}
			const result = await stopOne(dependencies, worker);
			dependencies.emitText(ctx, describe(result));
		},
	});
}

export const _testing = { stopOne, describe };
