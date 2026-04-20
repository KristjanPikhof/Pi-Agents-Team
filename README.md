# Pi Agents Team

Pi Agents Team turns one Pi session into an orchestrator that launches and supervises background RPC-backed worker agents.

- **Repo:** `git@github.com:KristjanPikhof/pi-agents-team.git`
- **Runtime:** [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) `>=0.68.0` (global `pi` CLI)
- **Node:** `>=20`

## What it does

- keeps the visible Pi session as the only user-facing orchestrator
- launches workers with isolated context windows via `pi --mode rpc`
- tracks workers with compact summaries and a verbatim `<final_answer>` block, never full transcripts
- exposes operator controls for status, ping, steer, follow-up, cancel, and result inspection
- enforces profile-based launch policy and scoped-write safety
- on warm session starts (`reload`/`resume`/`fork`/`new`), flags prior workers that were force-marked `exited` with a single warning toast so you never silently lose track of a batch

## Install

Pi Agents Team is distributed as a [Pi package](https://shittycodingagent.ai/packages). **It is not published to npm** — install it straight from Git. Pi's installer clones the repo, runs `npm install` automatically, and registers the extension declared under `"pi"` in `package.json`.

### Option A — install permanently

```bash
# SSH (requires git: prefix for git@host:path shorthand)
pi install git:git@github.com:KristjanPikhof/pi-agents-team

# or HTTPS (prefix optional for http/https/ssh protocol URLs)
pi install https://github.com/KristjanPikhof/pi-agents-team
```

Defaults to global settings (`~/.pi/agent/settings.json`). Add `-l` to write to project-local settings (`.pi/settings.json`) instead so the package is shared with your team and auto-installed on session start.

Pin to a ref to stop `pi update` from moving you forward:

```bash
pi install git:git@github.com:KristjanPikhof/pi-agents-team@v1.0.0
```

### Option B — try it once without installing

```bash
pi -e git:git@github.com:KristjanPikhof/pi-agents-team
```

Pi clones to a temp directory for that single run.

### Option C — develop locally

```bash
git clone git@github.com:KristjanPikhof/pi-agents-team.git
cd pi-agents-team
npm install
npm run check          # typecheck + all 53 tests

# run the extension directly from your working copy:
pi -e ./extensions/pi-agent-team/index.ts
pi -e ./extensions/pi-agent-team/index.ts -p "/team"   # open straight into the dashboard

# or install the local directory as a real Pi package:
pi install /absolute/path/to/pi-agents-team
```

### Requirements

- `pi` CLI (`@mariozechner/pi-coding-agent`) `>=0.68.0` on your PATH
- Node `>=20`
- Git (for `pi install git:…`). SSH installs respect `~/.ssh/config`; HTTPS installs prompt for credentials unless `GIT_TERMINAL_PROMPT=0` is set.

### Smoke scripts (for contributors)

```bash
npm run smoke:runtime   # spawns a real pi RPC worker
npm run smoke:team      # exercises TeamManager end-to-end
```

## Operator commands

| Command | What it does |
|---|---|
| `/team` | Opens the dashboard overlay (worker list + summary/console tabs). `/team <worker-id>` jumps directly to that worker's detail view. Opening triggers a live RPC refresh; press `r` inside the overlay to re-ping |
| `/team-copy <worker-id>` | Copies the worker's task, summary, final answer, transcript, and console timeline to the system clipboard. Inside the overlay, press `y` to do the same |
| `/team-prune` | Removes every terminal (idle/completed/aborted/error/exited) worker from the dashboard. Use after a cancelled batch to clear the slate before a fresh delegation |
| `/team-cost` | Per-worker token usage and a `Σ` aggregate row. Orchestrator usage stays in the Pi footer |
| `/agent-result <worker-id>` | Prints the worker's compact summary plus the verbatim `<final_answer>` block |
| `/agent-steer <worker-id\|all> <message>` | Sends a message to one or all workers. Auto-routes (steer if running, follow-up if idle) and reports the mode used |
| `/agent-followup <worker-id\|all> <message>` | Queues a follow-up for one or all workers |
| `/agent-cancel <worker-id\|all>` | Aborts and shuts down one worker, or every non-terminal worker |

## Orchestrator tools

The orchestrator does not drive workers through slash commands. It calls these tools:

| Tool | Use for |
|---|---|
| `delegate_task` | Launch a worker with a bounded task, chosen profile, and optional path scope |
| `wait_for_agents` | Block until every target hits terminal status **or** any target raises a new relay question. Zero-token wait. Wakes early on `relay_raised` so the orchestrator can answer mid-flight without waiting for the batch to finish |
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

## Session restore

Persisted state survives reloads via custom-typed session entries, but live worker processes are never silently reattached. Every worker that was live in the previous session (`running`, `starting`, `idle`, `waiting_followup`) is force-marked `exited` on the new session start. The session-start handler threads Pi's `SessionStartEvent.reason` (`startup` / `reload` / `new` / `resume` / `fork`) through, so:

- cold `startup` keeps the existing info toast (`Pi Agents Team loaded…`)
- any warm start (`reload` / `resume` / `fork` / `new`) with ≥1 flipped worker surfaces a single warning toast naming the count and reason, e.g. `Pi Agents Team: 3 workers from prior session marked exited (resume). Relaunch via delegate_task if still needed.`
- each flipped worker's `error` field in `/team` detail view carries a reason-specific message (`session resumed…`, `session forked…`, etc.)

Relaunch via `delegate_task` if you still need that work. This is deliberately honest — orphaned state is worse than forcing a relaunch.

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

## Contributing

Issues and PRs welcome at [github.com/KristjanPikhof/pi-agents-team](https://github.com/KristjanPikhof/pi-agents-team).

Before opening a PR: run `npm run check` (typecheck + 53 tests must be green) and update the relevant doc if operator-facing behavior or contract-level rules change. See [`CLAUDE.md`](CLAUDE.md) for the "what to do on each turn" checklist.
