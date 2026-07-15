import process from "node:process";
import { resolve } from "node:path";
import { comparePiVersions, MINIMUM_WORKER_PI_VERSION, parsePiVersion, probeWorkerPiVersion } from "../../src/runtime/pi-version";
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
	const parsedWorkerVersion = version.workerVersion && parsePiVersion(version.workerVersion);
	const parsedMinimumVersion = parsePiVersion(MINIMUM_WORKER_PI_VERSION)!;
	if (!version.supported || !parsedWorkerVersion || comparePiVersions(parsedWorkerVersion, parsedMinimumVersion) < 0) {
		throw new Error(version.message ?? `Selected Pi ${command} does not satisfy >=${MINIMUM_WORKER_PI_VERSION}`);
	}

	const handles: WorkerProcessHandle[] = [];
	const manager = new WorkerManager((options: WorkerProcessOptions) => {
		const handle = spawnWorkerProcess(options);
		handles.push(handle);
		return handle;
	}, probeWorkerPiVersion);
	const workerId = `smoke-${Date.now()}`;
	const cwd = process.cwd();
	const lifecycle: string[] = [];
	let statusAtAgentEnd: string | undefined;
	let resolved = false;
	const unsubscribe = manager.onEvent((worker, event) => {
		if (worker.workerId !== workerId) return;
		lifecycle.push(event.type);
		if (event.type === "worker_agent_end") statusAtAgentEnd = worker.state.status;
	});

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
			command,
			model: process.env.PI_AGENT_TEAM_SMOKE_MODEL,
			tools: ["read", "grep", "find", "ls", "bash"],
			extensionMode: "worker-minimal",
		});

		const done = new Promise<void>((resolveDone, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for settlement-backed worker idle state")), 60_000);
			const off = manager.onEvent((worker, event) => {
				if (worker.workerId !== workerId) return;
				if (event.type === "worker_error") {
					clearTimeout(timeout);
					off();
					reject(new Error(event.error));
					return;
				}
				if (event.type === "worker_idle") {
					clearTimeout(timeout);
					off();
					resolveDone();
				}
			});
		});

		await manager.promptWorker(workerId, "Reply with the single word ready and one short sentence describing your status.");
		await done;
		await manager.refreshStats(workerId);

		const agentEndIndex = lifecycle.indexOf("worker_agent_end");
		const idleIndex = lifecycle.indexOf("worker_idle");
		if (agentEndIndex < 0 || idleIndex <= agentEndIndex || statusAtAgentEnd !== "running") {
			throw new Error(`Expected running at worker_agent_end and idle only afterward; observed status=${statusAtAgentEnd}, ${lifecycle.join(" -> ")}`);
		}
		const worker = manager.getWorker(workerId);
		if (worker?.state.status !== "idle" || !worker.state.lastSummary) {
			throw new Error("Worker did not expose an idle final result after settlement");
		}

		resolved = true;
		console.log("Runtime smoke complete:");
		console.log(`Pi command: ${command}`);
		console.log(`Pi version: ${version.workerVersion} (minimum ${MINIMUM_WORKER_PI_VERSION})`);
		console.log(`Settlement: worker_agent_end status=${statusAtAgentEnd} -> worker_idle`);
		console.log(`Final result: ${worker.state.lastSummary.headline}`);
		console.log(`Tokens: ${worker.state.usage.inputTokens}/${worker.state.usage.outputTokens}`);
	} finally {
		unsubscribe();
		await manager.dispose();
		const leakedPids = handles.map((handle) => handle.pid).filter(isProcessRunning);
		console.log(`RPC cleanup: ${leakedPids.length === 0 ? "clean" : `leaked pids ${leakedPids.join(", ")}`}`);
		if (leakedPids.length > 0 || !resolved) process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
