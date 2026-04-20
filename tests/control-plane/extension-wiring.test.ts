import test from "node:test";
import assert from "node:assert/strict";
import extension from "../../extensions/pi-agent-team/index";

interface RegisteredTool {
	name: string;
}

interface RegisteredCommand {
	name: string;
}

test("extension registers control-plane tools and operator commands", () => {
	const tools: RegisteredTool[] = [];
	const commands: RegisteredCommand[] = [];
	const events: string[] = [];

	extension({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push({ name });
		},
		on(event: string) {
			events.push(event);
		},
		appendEntry() {},
		sendMessage() {},
	} as any);

	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["agent_cancel", "agent_message", "agent_result", "agent_status", "delegate_task", "ping_agents", "wait_for_agents"],
	);
	assert.ok(commands.some((command) => command.name === "team"));
	assert.ok(commands.some((command) => command.name === "team-status"));
	assert.ok(commands.some((command) => command.name === "agents"));
	assert.ok(commands.some((command) => command.name === "ping-agents"));
	assert.ok(commands.some((command) => command.name === "agent-steer"));
	assert.ok(commands.some((command) => command.name === "agent-followup"));
	assert.ok(commands.some((command) => command.name === "agent-cancel"));
	assert.ok(commands.some((command) => command.name === "agent-result"));
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("before_agent_start"));
});
