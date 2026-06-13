import process from "node:process";
import { TeamManager } from "../../src/control-plane/team-manager";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIdle(teamManager: TeamManager, workerId: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const worker = teamManager.getWorkerStatus(workerId);
		if (worker && worker.status !== "running" && worker.status !== "starting") {
			return;
		}
		await sleep(500);
	}
	throw new Error(`Timed out waiting for worker ${workerId} to become idle`);
}

async function main(): Promise<void> {
	const teamManager = new TeamManager();
	let workerId: string | undefined;

	try {
		const delegated = await teamManager.delegateTask({
			title: "Smoke team flow",
			goal:
				"Run this exact bash command first: python -c \"import time; print('working'); time.sleep(4); print('done')\". After it finishes, summarize what happened in one sentence.",
			profileName: "explorer",
			cwd: process.cwd(),
			contextHints: [
				"Use bash exactly once with the provided python command so the orchestrator can steer you while the command is running.",
			],
			model: process.env.PI_AGENT_TEAM_SMOKE_MODEL ?? "",
		});
		workerId = delegated.worker.workerId;

		await sleep(750);
		await teamManager.messageWorker(workerId, "After the long-running command, explicitly mention that the orchestrator steered you.", "steer");
		await waitForIdle(teamManager, workerId);

		const [ping] = await teamManager.pingWorkers({ workerIds: [workerId], mode: "active" });
		if (!ping) {
			throw new Error("Active ping returned no worker result");
		}

		console.log("Team flow smoke complete:");
		console.log(`Worker: ${ping.worker.workerId}`);
		console.log(`Status: ${ping.worker.status}`);
		console.log(`Summary: ${ping.worker.lastSummary?.headline ?? "(none)"}`);
		console.log(`Relays: ${ping.worker.pendingRelayQuestions.length}`);
	} finally {
		await teamManager.dispose();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
