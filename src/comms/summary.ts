import type { RelayQuestion, WorkerRuntimeState, WorkerSummary } from "../types";

function trimLine(line: string): string {
	return line.replace(/^[-*]\s*/, "").trim();
}

function findScalar(text: string, label: string): string | undefined {
	const pattern = new RegExp(`^${label}:\\s*(.+)$`, "im");
	const match = text.match(pattern);
	return match?.[1]?.trim();
}

function findList(text: string, label: string): string[] {
	const lines = text.split("\n");
	const values: string[] = [];
	let collecting = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!collecting) {
			if (new RegExp(`^${label}:\\s*$`, "i").test(line)) {
				collecting = true;
			}
			continue;
		}

		if (!line.trim()) break;
		if (/^[a-z_ ]+:\s*/i.test(line) && !/^[-*]\s*/.test(line)) break;
		values.push(trimLine(line));
	}

	return values.filter(Boolean);
}

function fallbackHeadline(text: string, worker: WorkerRuntimeState): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) {
		return worker.currentTask?.title ?? `${worker.profileName}:${worker.status}`;
	}
	return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

const PLACEHOLDER_RELAY_VALUES = new Set([
	"",
	"none",
	"no",
	"nope",
	"n/a",
	"na",
	"not needed",
	"not applicable",
	"no question",
	"no questions",
	"no relay",
	"no relay needed",
	"no relay_question",
	"-",
	"—",
	"null",
	"undefined",
]);

function isPlaceholderRelay(value: string): boolean {
	const normalized = value.trim().toLowerCase().replace(/[.!?]+$/, "");
	return PLACEHOLDER_RELAY_VALUES.has(normalized);
}

export function extractRelayQuestions(text: string, worker: WorkerRuntimeState): RelayQuestion[] {
	const relayQuestion = findScalar(text, "relay_question") ?? findScalar(text, "relay question");
	if (!relayQuestion || isPlaceholderRelay(relayQuestion)) return [];

	const assumption =
		findScalar(text, "assumption") ?? "No assumption supplied by the worker; orchestrator should decide the next step.";
	const choices = findList(text, "choices");
	const urgency = (findScalar(text, "urgency") ?? "medium").toLowerCase();
	const safeUrgency = urgency === "low" || urgency === "high" ? urgency : "medium";
	const taskId = worker.currentTask?.taskId ?? worker.workerId;

	return [
		{
			relayId: `${worker.workerId}:${taskId}:${Buffer.from(relayQuestion).toString("base64url").slice(0, 10)}`,
			workerId: worker.workerId,
			taskId,
			question: relayQuestion,
			assumption,
			urgency: safeUrgency,
			choices: choices.length > 0 ? choices : undefined,
			createdAt: Date.now(),
		},
	];
}

export function buildWorkerSummaryFromText(text: string, worker: WorkerRuntimeState): WorkerSummary {
	const headline = findScalar(text, "headline") ?? findScalar(text, "summary") ?? fallbackHeadline(text, worker);
	const readFiles = findList(text, "read_files");
	const changedFiles = findList(text, "changed_files");
	const risks = findList(text, "risks");
	const nextRecommendation = findScalar(text, "next_recommendation") ?? findScalar(text, "next recommendation");
	const relayQuestions = extractRelayQuestions(text, worker);

	return {
		workerId: worker.workerId,
		taskId: worker.currentTask?.taskId ?? worker.workerId,
		headline,
		status: worker.status,
		currentToolName: worker.lastToolName,
		readFiles,
		changedFiles,
		risks,
		nextRecommendation,
		relayQuestionCount: relayQuestions.length,
		updatedAt: Date.now(),
	};
}
