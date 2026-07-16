import { Text } from "@earendil-works/pi-tui";
import { type AgentToolName, type AgentToolTitleArgs, buildAgentToolCallTitle } from "./display-grammar.js";

type MutableText = Text & { setText(text: string): void };

type ToolRenderTheme = {
	bold(text: string): string;
	fg(color: string, text: string): string;
};

type ToolRenderContext = {
	lastComponent?: unknown;
};

function coerceAgentToolTitleArgs(args: unknown): AgentToolTitleArgs {
	if (!args || typeof args !== "object") return {};
	const record = args as Record<string, unknown>;
	return {
		profileName: typeof record.profileName === "string" ? record.profileName : undefined,
		workerId: typeof record.workerId === "string" ? record.workerId : undefined,
		workerIds: Array.isArray(record.workerIds) ? record.workerIds.filter((item): item is string => typeof item === "string") : undefined,
		reuseWorkerId: typeof record.reuseWorkerId === "string" ? record.reuseWorkerId : undefined,
	};
}

export function renderAgentToolCallTitle(toolName: AgentToolName) {
	return (args: unknown, theme: ToolRenderTheme, context: ToolRenderContext = {}) => {
		const text = (context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0)) as MutableText;
		text.setText(theme.fg("toolTitle", theme.bold(buildAgentToolCallTitle(toolName, coerceAgentToolTitleArgs(args)))));
		return text;
	};
}
