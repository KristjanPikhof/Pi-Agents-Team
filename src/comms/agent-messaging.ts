import type { WorkerStatus } from "../types";

export type WorkerMessageDelivery = "auto" | "steer" | "follow_up";

export function resolveWorkerMessageDelivery(
	status: WorkerStatus,
	delivery: WorkerMessageDelivery = "auto",
): Exclude<WorkerMessageDelivery, "auto"> {
	if (delivery === "steer" || delivery === "follow_up") return delivery;
	return status === "running" ? "steer" : "follow_up";
}
