# Pi Agent Team

Pi Agent Team turns one Pi session into an orchestrator that launches and supervises background RPC-backed worker agents.

## What it does

- keeps the visible Pi session as the only user-facing orchestrator
- launches workers with isolated context windows via `pi --mode rpc`
- tracks workers with compact summaries and a verbatim `<final_answer>` block, never full transcripts
- exposes operator controls for status, ping, steer, follow-up, cancel, and result inspection
- enforces profile-based launch policy and scoped-write safety

## Quick start

Install dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
```

Load the extension directly in Pi:

```bash
pi -e ./extensions/pi-agent-team/index.ts -p "/team-status"
```

Run the smoke scripts:

```bash
npm run smoke:runtime
npm run smoke:team
```

## Operator commands

| Command | What it does |
|---|---|
| `/team` | Opens the dashboard overlay (worker list + summary/console tabs). `/team <worker-id>` jumps straight into that worker's detail view |
| `/team-status` | Prints the current orchestrator status and tracked workers |
| `/agents` | Lists tracked workers as one line each |
| `/ping-agents [active]` | Returns passive worker snapshots, or refreshes runtime state and stats in `active` mode |
| `/agent-result <worker-id>` | Prints the worker's compact summary plus the verbatim `<final_answer>` block |
| `/agent-steer <worker-id\|all> <message>` | Sends a message to one or all workers. Auto-routes (steer if running, follow-up if idle) and reports the mode used |
| `/agent-followup <worker-id\|all> <message>` | Queues a follow-up for one or all workers |
| `/agent-cancel <worker-id\|all>` | Aborts and shuts down one worker, or every non-terminal worker |

## Orchestrator tools

The orchestrator does not drive workers through slash commands. It calls these tools:

| Tool | Use for |
|---|---|
| `delegate_task` | Launch a worker with a bounded task, chosen profile, and optional path scope |
| `wait_for_agents` | Block until every targeted worker reaches a terminal status. Zero-token wait, no polling |
| `agent_result` | Read the worker's structured summary plus the verbatim `<final_answer>` block |
| `agent_status` / `ping_agents` | Cheap one-line snapshots. Use for spot checks, not loops |
| `agent_message` | Steer a running worker or queue follow-up on an idle one (auto-routes based on status) |
| `agent_cancel` | Abort a wedged worker |

The orchestrator prompt is opinionated about when to use each. See [`prompts/orchestrator.md`](prompts/orchestrator.md).

## How delegation works

1. Orchestrator picks a profile and calls `delegate_task`.
2. Launch policy validates path scope and extension mode, then the runtime spawns `pi --mode rpc`.
3. The worker receives its role prompt plus a task prompt that requires a `<final_answer>…</final_answer>` block in its final message.
4. RPC events are normalized into compact `WorkerRuntimeState`: status, last tool, last summary, pending relay questions, usage.
5. Orchestrator calls `wait_for_agents`, then `agent_result` on each worker, and synthesizes one user-facing answer.

## The final_answer contract

Every worker is told its final assistant message must wrap the deliverable in a single `<final_answer>…</final_answer>` block. Only those contents are forwarded to the orchestrator verbatim. Anything outside the block is treated as internal notes.

Why: it gives the orchestrator a single, predictable deliverable, keeps compact state honest, and makes it safe to synthesize without reading a transcript.

## Profiles and safety

Profiles live in [`profiles/`](profiles/). Prompts live in [`prompts/`](prompts/).

Key rules:

- workers never talk to the user directly
- workers launch with `extensionMode: worker-minimal` so they can't recursively boot the orchestrator
- read-only profiles can inspect broadly
- write-capable profiles (just `fixer` today) require an explicit writable path scope

See [`docs/profiles.md`](docs/profiles.md) for the full profile table and customization notes.

## Documentation map

- [`docs/architecture.md`](docs/architecture.md): system structure, runtime flow, state contract
- [`docs/operations.md`](docs/operations.md): install, run, inspect, ping, steer, troubleshoot
- [`docs/profiles.md`](docs/profiles.md): default profiles, launch policy, customization
- [`docs/prompting.md`](docs/prompting.md): orchestrator and worker prompt contracts

## Package layout

```text
extensions/pi-agent-team/index.ts    # extension entrypoint, tool + command registration, UI wiring
src/runtime/                         # worker process, RPC client, event normalizer, worker manager
src/control-plane/                   # team manager, task registry, persistence snapshots
src/comms/                           # steer/follow-up routing, passive ping, summary parser, relay extractor
src/profiles/                        # packaged profile specs + loader
src/safety/                          # launch policy and path-scope validation
src/ui/                              # status widget, dashboard text, interactive overlay
src/commands/                        # operator slash commands
prompts/                             # orchestrator and per-role worker contracts
profiles/                            # markdown profile definitions
tests/                               # unit + integration coverage (node:test)
scripts/smoke/                       # runtime-worker and team-flow smokes
```
