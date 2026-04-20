import type { RelayQuestion, WorkerRuntimeState } from "../types";

export interface WorkerPingSnapshot {
	workerId: string;
	profileName: string;
	status: WorkerRuntimeState["status"];
	taskTitle?: string;
	lastToolName?: string;
	lastSummary?: string;
	relayQuestions: RelayQuestion[];
	lastEventAt: number;
	usage: WorkerRuntimeState["usage"];
}

export function buildPassivePing(worker: WorkerRuntimeState): WorkerPingSnapshot {
	return {
		workerId: worker.workerId,
		profileName: worker.profileName,
		status: worker.status,
		taskTitle: worker.currentTask?.title,
		lastToolName: worker.lastToolName,
		lastSummary: worker.lastSummary?.headline,
		relayQuestions: worker.pendingRelayQuestions.map((question) => ({ ...question })),
		lastEventAt: worker.lastEventAt,
		usage: { ...worker.usage },
	};
}

export function formatPingSnapshot(snapshot: WorkerPingSnapshot): string {
	const parts = [`${snapshot.workerId} (${snapshot.profileName})`, `status=${snapshot.status}`];
	if (snapshot.taskTitle) parts.push(`task=${snapshot.taskTitle}`);
	if (snapshot.lastToolName) parts.push(`tool=${snapshot.lastToolName}`);
	if (snapshot.lastSummary) parts.push(`summary=${snapshot.lastSummary}`);
	if (snapshot.relayQuestions.length > 0) parts.push(`relays=${snapshot.relayQuestions.length}`);
	return parts.join(" · ");
}
