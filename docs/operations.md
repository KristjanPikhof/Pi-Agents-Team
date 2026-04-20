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

## Basic operator workflow

### Inspect the team

```text
/team
/agents
/team-status
```

- `/team` opens the dashboard overlay in interactive mode
- `/agents` prints the tracked workers
- `/team-status` prints a quick orchestrator snapshot

### Ping workers

```text
/ping-agents
/ping-agents active
```

Use passive ping first. It reads cached worker state, summaries, and relay counts. Use `active` when you want fresh runtime state and updated token stats.

### Steer or queue follow-up work

```text
/agent-steer <worker-id> narrow to src/runtime only
/agent-followup <worker-id> after that, summarize the remaining risks
```

Use steer when the worker is actively running. Use follow-up when the worker is idle or when the next instruction should wait.

### Cancel a worker

```text
/agent-cancel <worker-id>
```

This aborts the worker and shuts down its process.

## Delegation notes

The orchestrator-facing tool is `delegate_task`. In normal use you do not need to type the tool call yourself. Ask the orchestrator to delegate a bounded task and it can decide when to use the tool.

If a profile can write files, provide an explicit writable path scope. This matters most for `fixer`.

## Troubleshooting

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch the worker.

### A worker is restored after reload but not actually running

That is expected. Persisted workers are marked exited on restore so the operator can see what existed before the reload without being lied to about process liveness.

### Steer does nothing

Steer is for running workers. If the worker is already idle, use `/agent-followup` instead.

### A write-capable worker is rejected

The launch policy is doing its job. Add an explicit writable path scope for the delegated task, or use a read-only profile.

## Local verification commands

```bash
npm run typecheck
npm test
pi -e ./extensions/pi-agent-team/index.ts -p "/team-status"
pi -e ./extensions/pi-agent-team/index.ts -p "/team"
pi -e ./extensions/pi-agent-team/index.ts -p "/ping-agents"
```
