import process from "node:process";
import { resolve } from "node:path";
import { DEFAULT_TEAM_CONFIG } from "../../src/config";
import { TeamManager } from "../../src/control-plane/team-manager";
import { MINIMUM_WORKER_PI_VERSION, probeWorkerPiVersion } from "../../src/runtime/pi-version";
import { WorkerManager } from "../../src/runtime/worker-manager";
import { spawnWorkerProcess, type WorkerProcessHandle, type WorkerProcessOptions } from "../../src/runtime/worker-process";

function selectedPiCommand(): string {
	const injected = process.env.PI_AGENT_TEAM_SMOKE_PI_COMMAND?.trim();
	return injected || resolve(process.cwd(), "node_modules/.bin/pi");
}

function isProcessRunning(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function main(): Promise<void> {
	const command = selectedPiCommand();
	const version = await probeWorkerPiVersion({ command, cwd: process.cwd() });
	if (!version.supported || !version.workerVersion) {
		throw new Error(version.message ?? `Selected Pi ${command} does not satisfy >=${MINIMUM_WORKER_PI_VERSION}`);
	}

	const handles: WorkerProcessHandle[] = [];
	const workerManager = new WorkerManager((options: WorkerProcessOptions) => {
		const handle = spawnWorkerProcess(options);
		handles.push(handle);
		return handle;
	}, probeWorkerPiVersion);
	const config = structuredClone(DEFAULT_TEAM_CONFIG);
	config.rpc.command = command;
	const teamManager = new TeamManager({ config, workerManager });
	const lifecycle: string[] = [];
	const statusesAtAgentEnd: string[] = [];
	let workerId: string | undefined;
	let completed = false;
	const unsubscribe = workerManager.onEvent((worker, event) => {
		if (workerId && worker.workerId !== workerId) return;
		lifecycle.push(event.type);
		if (event.type === "worker_agent_end") statusesAtAgentEnd.push(worker.state.status);
	});

	try {
		const request = {
			title: "Smoke team flow",
			goal: "Reply with a final_answer whose headline says the team smoke worker is ready.",
			profileName: "explorer",
			cwd: process.cwd(),
			contextHints: ["Keep the response concise and do not use tools."],
			model: process.env.PI_AGENT_TEAM_SMOKE_MODEL,
		};
		const delegated = await teamManager.delegateTask(request);
		workerId = delegated.worker.workerId;

		const firstWait = await teamManager.waitForTerminal([workerId], { timeoutMs: 60_000, wakeOnRelay: false });
		if (firstWait.reason !== "all_terminal" || firstWait.workers[0]?.status !== "idle") {
			throw new Error(`First wait did not finish at settled idle: ${firstWait.reason}/${firstWait.workers[0]?.status}`);
		}
		const firstAgentEnd = lifecycle.indexOf("worker_agent_end");
		const firstIdle = lifecycle.indexOf("worker_idle");
		if (firstAgentEnd < 0 || firstIdle <= firstAgentEnd || statusesAtAgentEnd[0] !== "running") {
			throw new Error(`First task did not remain running at agent_end: ${lifecycle.join(" -> ")}`);
		}
		const firstResult = teamManager.getWorkerResult(workerId);
		if (firstResult?.worker.status !== "idle" || !firstResult.worker.finalAnswer) {
			throw new Error("First settled task did not expose a final result");
		}

		const reused = await teamManager.delegateTask({
			...request,
			title: "Reused smoke team flow",
			goal: "Reply with a final_answer whose headline confirms settled worker reuse.",
			reuseWorkerId: workerId,
		});
		if (reused.worker.workerId !== workerId || handles.length !== 1) {
			throw new Error("Post-settlement reuse spawned a different RPC process");
		}
		const secondWait = await teamManager.waitForTerminal([workerId], { timeoutMs: 60_000, wakeOnRelay: false });
		if (secondWait.reason !== "all_terminal" || secondWait.workers[0]?.status !== "idle") {
			throw new Error(`Reuse wait did not finish at settled idle: ${secondWait.reason}/${secondWait.workers[0]?.status}`);
		}
		const secondResult = teamManager.getWorkerResult(workerId);
		if (secondResult?.worker.status !== "idle" || !secondResult.worker.finalAnswer) {
			throw new Error("Reused settled task did not expose a final result");
		}
		if (
			lifecycle.filter((event) => event === "worker_idle").length !== 2
			|| statusesAtAgentEnd.length !== 2
			|| statusesAtAgentEnd.some((status) => status !== "running")
		) {
			throw new Error(`Expected each task to remain running at agent_end and idle once after settlement; observed ${lifecycle.join(" -> ")}`);
		}

		completed = true;
		console.log("Team flow smoke complete:");
		console.log(`Pi command: ${command}`);
		console.log(`Pi version: ${version.workerVersion} (minimum ${MINIMUM_WORKER_PI_VERSION})`);
		console.log(`Worker: ${workerId} (reused same RPC process)`);
		console.log(`Waits: ${firstWait.reason}, ${secondWait.reason}`);
		console.log(`Settlement: agent_end statuses=${statusesAtAgentEnd.join(",")} -> 2 worker_idle events`);
		console.log(`First result: ${firstResult.worker.lastSummary?.headline ?? firstResult.worker.finalAnswer}`);
		console.log(`Reused result: ${secondResult.worker.lastSummary?.headline ?? secondResult.worker.finalAnswer}`);
	} finally {
		unsubscribe();
		await teamManager.dispose();
		const leakedPids = handles.map((handle) => handle.pid).filter(isProcessRunning);
		console.log(`RPC cleanup: ${leakedPids.length === 0 ? "clean" : `leaked pids ${leakedPids.join(", ")}`}`);
		if (leakedPids.length > 0 || !completed) process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
