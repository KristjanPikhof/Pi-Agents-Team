import process from "node:process";
import { WorkerManager } from "../../src/runtime/worker-manager";

async function main(): Promise<void> {
	const manager = new WorkerManager();
	const workerId = `smoke-${Date.now()}`;
	const cwd = process.cwd();
	let resolved = false;

	try {
		await manager.launchWorker({
			workerId,
			profileName: "explorer",
			task: {
				taskId: workerId,
				title: "Runtime smoke",
				goal: "Verify the runtime worker can launch and respond through RPC.",
				requestedBy: "operator",
				profileName: "explorer",
				cwd,
				contextHints: ["Return a concise readiness check."],
				createdAt: Date.now(),
			},
			cwd,
			model: process.env.PI_AGENT_TEAM_SMOKE_MODEL,
			tools: ["read", "grep", "find", "ls", "bash"],
			extensionMode: "worker-minimal",
		});

		const done = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for worker idle state")), 45_000);
			const unsubscribe = manager.onEvent((worker, event) => {
				if (worker.workerId !== workerId) return;
				if (event.type === "worker_error") {
					clearTimeout(timeout);
					unsubscribe();
					reject(new Error(event.error));
					return;
				}
				if (event.type === "worker_idle") {
					clearTimeout(timeout);
					unsubscribe();
					resolve();
				}
			});
		});

		await manager.promptWorker(workerId, "Reply with the single word ready and one short sentence describing your status.");
		await done;
		await manager.refreshStats(workerId);

		const worker = manager.getWorker(workerId);
		if (!worker?.state.lastSummary) {
			throw new Error("Worker finished without a summary");
		}

		resolved = true;
		console.log("Smoke worker summary:");
		console.log(worker.state.lastSummary.headline);
		console.log(`Tokens: ${worker.state.usage.inputTokens}/${worker.state.usage.outputTokens}`);
	} finally {
		await manager.dispose();
		if (!resolved) {
			process.exitCode = 1;
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
