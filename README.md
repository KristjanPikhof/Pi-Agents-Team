# Pi Agents Team

One Pi session orchestrates. Background RPC workers do the work. The orchestrator never sees worker transcripts, only compact summaries and a single `<final_answer>` block per worker.

**Repo:** `git@github.com:KristjanPikhof/pi-agents-team.git`
**Requires:** `pi` CLI ([`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)) `>=0.69.0`, Node `>=20`, Git.

## Install

Install from npm once the package is published:

```bash
pi install pi-agents-team
```

Pin to a specific published version when you want reproducible team setup:

```bash
pi install pi-agents-team@2026.4.23
```

Pi downloads the package, runs `npm install`, and registers the extension declared in `package.json`.

You can also install from Git using one of the options below. This is useful before the first npm publish, when testing a branch, or when pinning to an unreleased ref.

### Option 1: Git via `pi install`

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
      "extensions": ["./extensions/index.ts"]
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
| `/team` | Open the keyboard-first dashboard overlay. Wide terminals show a split queue + inspector view; narrow terminals stack them. `/team <worker-id>` jumps straight to that worker's inspector. Press `r` in the overlay to re-ping, `y` to copy, and use Overview / Deliverable / Console tabs for worker detail. |
| `/team-copy <worker-id>` | Copy the worker's task, summary, final answer, and console timeline to the clipboard. |
| `/team-prune` | Remove every terminal worker (idle/completed/aborted/error/exited) from the dashboard. |
| `/team-cost` | Per-worker token usage plus a `Σ` aggregate row. Orchestrator usage stays in the Pi footer. |
| `/team-init global\|local [--force]` | Scaffold `agents-team.json` with every built-in role stamped in place, plus the current `schemaVersion` + `scaffoldVersion` markers and top-level worker access defaults like `allowPathsOutsideProject: true`. Refuses existing files without `--force`; on `--force` the previous file is copied (not renamed — original stays put until the new write succeeds) to `YYYY-MM-DD-HHMMSS-agents-team.json` first. |
| `/team-enable global\|local` | Set `enabled: true` in the scoped config file. Run `/reload` to apply. |
| `/team-disable global\|local` | Set `enabled: false` in the scoped config file. The extension stays loaded but goes dormant (no tools, no prompt, no UI) until re-enabled. |
| `/agent-result <worker-id>` | Print the compact summary plus the verbatim `<final_answer>` block. |
| `/agent-steer <worker-id\|all> <msg>` | Send a message. Routes by status: `steer` if running, re-`prompt` if idle/waiting_followup (wakes the session). |
| `/agent-followup <worker-id\|all> <msg>` | Queue onto the live stream if running; re-`prompt` if idle/waiting_followup. |
| `/agent-cancel <worker-id\|all>` | Abort one worker, or every non-terminal worker. |

## How it works (in one paragraph)

The orchestrator may answer trivial, already-known, or tiny bounded asks directly; substantial investigation, review, mapping, tests, and multi-file work goes to background workers. For delegated work, the orchestrator picks a role from the loaded config (seven built-ins by default: explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. If `delegate_task.skills` names installed Pi skills, worker skill discovery is enabled and the worker is told to load and apply those requested skill names from its available skill context. Worker RPC events get normalized into compact state: status, last tool, last summary, pending relay questions, token usage. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions), reads each worker's `agent_result`, and synthesizes one user-facing answer. Optional config lives at `~/.pi/agent/agents-team.json` (global) and/or `<project>/.pi/agent/agents-team.json` (nearest ancestor of cwd). The project file, if present, fully replaces global; nothing merges across layers. Role names are free-form, so you can rename the seven defaults, drop the ones you don't need, or add your own. Top-level controls include `enabled: false` (dormant mode) and `workerAccess.allowPathsOutsideProject: false` (restrict delegated worker path scopes to the project root/current cwd; prompt-file containment remains unchanged). Use `/team-init`, `/team-enable`, and `/team-disable` to manage these files without editing JSON.

## Documentation

| File | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Layering, runtime flow, state contract, animation layer. |
| [`docs/operations.md`](docs/operations.md) | Install, dashboard keys, copy flow, steer semantics, troubleshooting. |
| [`docs/profiles.md`](docs/profiles.md) | Default roles, how to create your own, prompt resolution, project vs global config, version bumps, launch-time safety. |
| [`docs/prompting.md`](docs/prompting.md) | Orchestrator + worker prompt contracts, the `<final_answer>` rules. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Local dev setup, tests, smoke scripts, package layout. |
| [`CLAUDE.md`](CLAUDE.md) | Load-bearing invariants and anti-patterns. Read before touching state transitions. |

## License

[MIT](LICENSE). Copyright © 2026 Kristjan Pikhof.
