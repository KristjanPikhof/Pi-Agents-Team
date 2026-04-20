# Operations guide

## Quick start

Install dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
```

Smoke the runtime and team flow:

```bash
npm run smoke:runtime
npm run smoke:team
```

Load the extension directly:

```bash
pi -e ./extensions/pi-agent-team/index.ts
```

Run one test file:

```bash
tsx --test tests/runtime/worker-manager.test.ts
```

## Inspect the team

```text
/team
/team-status
/agents
```

- `/team` opens the interactive dashboard overlay in TUI mode, or prints the dashboard text in print mode.
- `/team-status` prints the orchestrator snapshot, launch config, and active-worker lines.
- `/agents` prints one line per tracked worker (`wN · profile · status`).

### Dashboard keys

Inside the `/team` overlay:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection in the worker list |
| `enter` | Open the selected worker in detail view |
| `s` / `c` | Switch between Summary and Console tabs |
| `j`/`k` or `↑`/`↓` | Scroll detail view |
| `PgUp` / `PgDn` | Page scroll |
| `g` / `G` | Jump to top / bottom |
| `r` | Refresh snapshot |
| `esc` | Back to list (or close from list) |
| `q` | Close overlay |

The Console tab shows a bounded ring buffer of status transitions, tool starts and ends, assistant-text flushes, queue updates, errors, and exit reasons. Use it when a summary is not enough.

## Ping workers

```text
/ping-agents
/ping-agents active
```

Use passive ping first. It reads cached state, summaries, and relay counts without hitting the worker process. Use `active` when you want fresh runtime state and refreshed token stats (it issues RPC `getState` + `getSessionStats` per worker).

## Inspect a worker's result

```text
/agent-result <worker-id>
```

Prints the compact summary (headline, files read/changed, risks, next recommendation, pending relays, usage) plus the verbatim contents of the worker's `<final_answer>` block. This is the authoritative deliverable. If the block is empty, the worker did not follow the contract: re-delegate, steer it with a corrective message, or cancel.

## Steer or queue follow-up work

```text
/agent-steer <worker-id> narrow to src/runtime only
/agent-followup <worker-id> after that, summarize the remaining risks
```

Use `steer` while the worker is running. Use `follow-up` when the worker is idle, or when the next instruction should wait its turn.

The orchestrator's `agent_message` tool has a third option, `delivery: "auto"`, which routes based on current status (`steer` if `running`, `follow_up` otherwise).

## Cancel a worker

```text
/agent-cancel <worker-id>
```

Aborts the RPC session and shuts down the worker process. The compact state is marked `aborted`; persisted state survives.

## Delegation notes

The orchestrator-facing tool is `delegate_task`. In normal use you do not type the tool call yourself: ask the orchestrator for the work and it decides when to delegate.

If a profile can write files (today, only `fixer`), provide an explicit writable path scope. Launch policy rejects write-capable tasks without one.

The orchestrator should pair every `delegate_task` with a `wait_for_agents` call, then `agent_result` per worker, and synthesize a single answer. It should not loop `ping_agents`, should not sleep in bash, and should not run investigation tools itself while workers are active. See [`../prompts/orchestrator.md`](../prompts/orchestrator.md).

## Troubleshooting

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch.

### A worker is restored after reload but not actually running

Expected. Persisted workers are force-marked `exited` on restore so the operator sees what existed before the reload without being misled about process liveness. Relaunch if you still need that work.

### Steer does nothing

Steer only applies to running workers. If the worker is idle, use `/agent-followup` instead. The orchestrator's `agent_message` with `delivery: "auto"` picks the right mode for you.

### A write-capable worker is rejected

Launch policy is doing its job. `fixer` requires an explicit writable `pathScope`. Either provide one on the delegated task or switch to a read-only profile like `explorer`, `reviewer`, or `oracle`.

### `agent_result` returns an empty `<final_answer>`

The worker finished but did not follow the contract. Three moves, in order of preference: re-delegate with smaller slices, steer the existing worker with a corrective message asking it to re-issue the final answer, or cancel and re-spawn with a better brief. Do not fall back to running `bash`/`read`/`grep` yourself.

### "Worker finished" toast fired, but the worker is still running

Fixed. The `starting → idle` race has a guard in `applyNormalizedEvent` (worker stays `starting` until actually prompted) plus a filter in `flushTerminalNotifications` that drops entries whose status has flipped back off-terminal by flush time. If you see this again, it is a real bug: check `src/runtime/worker-manager.ts` and the `onStateChange` listener in `extensions/pi-agent-team/index.ts`.

## Local verification commands

```bash
npm run typecheck
npm test
pi -e ./extensions/pi-agent-team/index.ts -p "/team-status"
pi -e ./extensions/pi-agent-team/index.ts -p "/team"
pi -e ./extensions/pi-agent-team/index.ts -p "/ping-agents"
pi -e ./extensions/pi-agent-team/index.ts -p "/agents"
```
