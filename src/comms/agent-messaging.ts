import type { WorkerStatus } from "../types";

export type WorkerMessageDeliveryInput = "auto" | "steer" | "follow_up";
export type WorkerMessageDeliveryResolved = "steer" | "follow_up" | "prompt";

export type WorkerMessageDelivery = WorkerMessageDeliveryInput;

export function resolveWorkerMessageDelivery(
	status: WorkerStatus,
	delivery: WorkerMessageDeliveryInput = "auto",
): WorkerMessageDeliveryResolved {
	if (status !== "running") return "prompt";
	if (delivery === "follow_up") return "follow_up";
	return "steer";
}
