# Pi Agent Team

Pi Agent Team turns one Pi session into an orchestrator that can launch and supervise RPC-backed worker agents.

## What it does

- keeps the visible Pi session as the only user-facing orchestrator
- launches background workers with isolated context windows
- tracks workers with compact summaries instead of dumping raw transcripts into the main session
- supports operator controls for status, ping, steer, follow-up, and cancel flows
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
| `/team` | Opens the dashboard overlay in interactive mode, prints the dashboard in print mode |
| `/team-status` | Prints the current orchestrator status and tracked workers |
| `/agents` | Lists tracked workers |
| `/ping-agents [active]` | Returns passive worker status, or refreshes runtime state and stats in `active` mode |
| `/agent-steer <worker-id> <message>` | Sends a steer message to a running worker |
| `/agent-followup <worker-id> <message>` | Queues follow-up work for an idle worker |
| `/agent-cancel <worker-id>` | Aborts and shuts down a worker |
| `/agent-result <worker-id>` | Prints the latest compact result for one worker |

## How delegation works

1. The orchestrator chooses a profile.
2. The control plane resolves launch policy.
3. Pi starts a worker with `pi --mode rpc`.
4. The worker receives a Pi-native prompt contract plus a bounded task prompt.
5. Runtime events are normalized into compact worker state.
6. The operator can inspect or control the worker without leaving Pi.

## Profiles and safety

Profiles live in [`profiles/`](profiles/) and prompts live in [`prompts/`](prompts/).

A few important rules:

- workers never talk to the user directly
- recursive orchestrator launches are blocked by default
- read-only profiles can inspect broadly
- write-capable profiles, especially `fixer`, require an explicit writable path scope

See [`docs/profiles.md`](docs/profiles.md) for the full profile table and customization notes.

## Documentation map

- [`docs/architecture.md`](docs/architecture.md): system structure and key decisions
- [`docs/operations.md`](docs/operations.md): install, run, inspect, ping, steer, and troubleshoot
- [`docs/profiles.md`](docs/profiles.md): default profiles and safety policy
- [`docs/prompting.md`](docs/prompting.md): orchestrator and worker prompt contracts

## Package layout

```text
extensions/pi-agent-team/index.ts    # extension entrypoint
src/runtime/                         # RPC transport and worker manager
src/control-plane/                   # task registry, persistence, team orchestration
src/comms/                           # steer/follow-up, ping, summary, relay helpers
src/profiles/                        # packaged profile loader
src/safety/                          # launch policy and path-scope validation
src/ui/                              # status widget, dashboard, overlay
src/commands/                        # operator slash commands
prompts/                             # orchestrator and worker prompt contracts
profiles/                            # packaged worker profile definitions
tests/                               # unit and integration coverage
scripts/smoke/                       # local smoke scripts
```

## Current status

The package now includes:

- real RPC worker launch and lifecycle management
- delegation tools and persisted compact worker state
- Pi-native orchestrator and worker prompt contracts
- profile loading plus launch safety checks
- communication helpers for steer, follow-up, ping, and relay capture
- operator dashboard helpers and slash commands
- test coverage plus local smoke scripts

If you want the implementation details, start with [`docs/architecture.md`](docs/architecture.md).
