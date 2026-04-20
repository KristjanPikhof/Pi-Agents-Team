import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { RpcClient, StrictJsonlParser } from "../../src/runtime/rpc-client";

test("StrictJsonlParser splits only on LF", () => {
	const records: Array<Record<string, unknown>> = [];
	const parser = new StrictJsonlParser(
		(record) => records.push(record),
		(error) => {
			throw error;
		},
	);

	const payload = JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello\u2028world" },
	});

	parser.push(`${payload}\n`);

	assert.equal(records.length, 1);
	assert.equal((records[0].assistantMessageEvent as { delta: string }).delta, "hello world");
});

test("RpcClient correlates requests and responses", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const client = new RpcClient({ stdin, stdout });

	stdin.on("data", (chunk) => {
		const line = chunk.toString().trim();
		const command = JSON.parse(line) as { id: string; type: string; message: string };
		stdout.write(
			`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { ok: true } })}\n`,
		);
	});

	const result = await client.send<{ ok: boolean }>({ type: "steer", message: "Focus on tests" });
	assert.deepEqual(result, { ok: true });

	client.dispose();
});
