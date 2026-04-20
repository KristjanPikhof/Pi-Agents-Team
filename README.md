# Pi Agents Team

One Pi session orchestrates. Background RPC workers do the work. The orchestrator never sees worker transcripts, only compact summaries and a single `<final_answer>` block per worker.

**Repo:** `git@github.com:KristjanPikhof/pi-agents-team.git`
**Requires:** `pi` CLI ([`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)) `>=0.68.0`, Node `>=20`, Git.

## Install

Not published to npm. Install from Git using one of the three options below. Pi clones the repo, runs `npm install`, and registers the extension declared in `package.json`.

### Option 1: `pi install` (recommended)

```bash
# SSH (the git: prefix is required for git@host:path shorthand)
pi install git:git@github.com:KristjanPikhof/pi-agents-team

# HTTPS (prefix optional for protocol URLs)
pi install https://github.com/KristjanPikhof/pi-agents-team
```

Writes to global settings (`~/.pi/agent/settings.json`). Add `-l` to write to project settings (`.pi/settings.json`) so your team auto-installs it on session start.

Pin to a ref to skip `pi update`:

```bash
pi install git:git@github.com:KristjanPikhof/pi-agents-team@v1.0.0
```

### Option 2: Edit settings.json by hand

Add an entry to the `packages` array. Pi installs any missing packages the next time a session starts.

**Global**, in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:git@github.com:KristjanPikhof/pi-agents-team"
  ]
}
```

**Project-local**, in `.pi/settings.json` (shared with your team via git):

```json
{
  "packages": [
    "git:git@github.com:KristjanPikhof/pi-agents-team@v1.0.0"
  ]
}
```

Entries can also be objects if you need to filter what the package exposes:

```json
{
  "packages": [
    {
      "source": "git:git@github.com:KristjanPikhof/pi-agents-team",
      "extensions": ["extensions/pi-agent-team/index.ts"]
    }
  ]
}
```

### Option 3: One-off trial

```bash
pi -e git:git@github.com:KristjanPikhof/pi-agents-team
```

Clones to a temp directory for a single run. Nothing is written to your settings.

## Operator commands

Slash commands available once the extension is loaded. The orchestrator's own tool surface (`delegate_task`, `wait_for_agents`, `agent_result`, etc.) is documented in [`docs/prompting.md`](docs/prompting.md); you don't invoke those directly.

| Command | What it does |
|---|---|
| `/team` | Open the dashboard overlay. `/team <worker-id>` jumps straight to that worker. Press `r` in the overlay to re-ping, `y` to copy. |
| `/team-copy <worker-id>` | Copy the worker's task, summary, final answer, and console timeline to the clipboard. |
| `/team-prune` | Remove every terminal worker (idle/completed/aborted/error/exited) from the dashboard. |
| `/team-cost` | Per-worker token usage plus a `Σ` aggregate row. Orchestrator usage stays in the Pi footer. |
| `/agent-result <worker-id>` | Print the compact summary plus the verbatim `<final_answer>` block. |
| `/agent-steer <worker-id\|all> <msg>` | Send a message. Auto-routes: `steer` if running, `follow_up` if idle. |
| `/agent-followup <worker-id\|all> <msg>` | Always queue as `follow_up`. |
| `/agent-cancel <worker-id\|all>` | Abort one worker, or every non-terminal worker. |

## How it works (in one paragraph)

The orchestrator picks a profile (explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. Worker RPC events get normalized into compact state: status, last tool, last summary, pending relay questions, token usage. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions), reads each worker's `agent_result`, and synthesizes one user-facing answer.

## Documentation

| File | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Layering, runtime flow, state contract, animation layer. |
| [`docs/operations.md`](docs/operations.md) | Install, dashboard keys, copy flow, steer semantics, troubleshooting. |
| [`docs/profiles.md`](docs/profiles.md) | Default profiles, launch policy, customization. |
| [`docs/prompting.md`](docs/prompting.md) | Orchestrator + worker prompt contracts, the `<final_answer>` rules. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Local dev setup, tests, smoke scripts, package layout. |
| [`CLAUDE.md`](CLAUDE.md) | Load-bearing invariants and anti-patterns. Read before touching state transitions. |

## License

MIT.
