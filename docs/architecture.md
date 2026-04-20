# Pi Agent Team architecture

## TL;DR

Pi Agent Team keeps one visible Pi session as the orchestrator and pushes delegated work into background RPC workers. The orchestrator stays in charge of user dialogue, worker selection, supervision, and result integration. Workers stay isolated, report compact summaries, and never become separate user-facing chats.

## Why this exists

Pi is good at deep work, but a single long session eventually runs into context pressure. This package solves that by moving bounded tasks into separate worker sessions while preserving one coherent orchestrator thread.

## Core contract

The package makes three opinionated choices:

1. **One user-facing agent.** The main session is always the orchestrator.
2. **Background workers only.** Workers talk to the orchestrator, not to the user.
3. **Compact state over transcripts.** The orchestrator stores summaries, relay questions, status, and results. It does not mirror full worker conversations back into the main context.

## Runtime topology

```text
User
  ↓
Main Pi session (orchestrator)
  ↓
Extension entrypoint
  ├─ Control plane
  │   ├─ TeamManager
  │   ├─ TaskRegistry
  │   └─ Persistence helpers
  ├─ Runtime layer
  │   ├─ WorkerProcess
  │   ├─ RpcClient
  │   ├─ Event normalizer
  │   └─ WorkerManager
  ├─ Profiles + safety
  │   ├─ Profile loader
  │   ├─ Launch policy
  │   └─ Path-scope checks
  ├─ Comms layer
  │   ├─ Summary parser
  │   ├─ Relay queue
  │   └─ Ping helpers
  └─ Operator UI
      ├─ Footer/widget status
      ├─ Dashboard overlay
      └─ Slash commands
```

## Key decisions

### Pi RPC is the worker transport

Workers run through `pi --mode rpc`. That gives us prompt, steer, follow-up, abort, state, and stats commands without inventing another agent protocol.

### Workers launch with reduced discovery

The default launch mode is `worker-minimal`, which disables recursive extension discovery. This keeps workers from accidentally booting the full orchestrator package again.

### Write-capable profiles need path scope

The `fixer` profile is intentionally stricter than the read-heavy roles. If a worker can edit files, it needs an explicit writable scope. That is the simplest guardrail against unsafe overlap in a multi-worker setup.

### Session restore is honest

Persisted state survives reloads, but live worker processes do not get silently reattached. Restored workers are marked exited and require relaunch. That keeps the control plane honest about what is and is not actually running.

## Package structure

```text
extensions/pi-agent-team/index.ts
src/config.ts
src/types.ts
src/runtime/
src/control-plane/
src/comms/
src/profiles/
src/safety/
src/ui/
src/commands/
prompts/
profiles/
docs/
tests/
scripts/smoke/
```

## What is stored

Persisted session state includes:

- delegated task metadata
- worker ids and compact runtime state
- compact summaries
- pending relay questions
- UI-friendly dashboard snapshots

Persisted session state does **not** include:

- full worker transcripts
- raw streaming deltas
- arbitrary tool output dumps

## Operator surface

The operator stays in Pi and uses commands such as:

- `/team`
- `/agents`
- `/ping-agents`
- `/agent-steer`
- `/agent-followup`
- `/agent-cancel`

These are supervision controls, not alternate chat channels.

## What to read next

- [`operations.md`](operations.md) for install, smoke, and troubleshooting
- [`profiles.md`](profiles.md) for profile policy and write-scope rules
- [`prompting.md`](prompting.md) for orchestrator and worker prompt contracts
