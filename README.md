# Pi Agents Team

One Pi session orchestrates. Background RPC workers do the work. The orchestrator never sees worker transcripts, only compact summaries and a single `<final_answer>` block per worker.

**Repo:** `git@github.com:KristjanPikhof/pi-agents-team.git`
**Requires:** `pi` CLI ([`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)) `>=0.69.0`, Node `>=20`, Git.

## Install

Install from npm:

```bash
pi install npm:pi-agents-team
```

You can also install from Git using one of the options below.

### Option 1: Git via `pi install`

```bash
# SSH (the git: prefix is required for git@host:path shorthand)
pi install git:git@github.com:KristjanPikhof/pi-agents-team

# HTTPS (prefix optional for protocol URLs)
pi install https://github.com/KristjanPikhof/pi-agents-team
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
    "git:git@github.com:KristjanPikhof/pi-agents-team"
  ]
}
```

Clones to a temp directory for a single run. Nothing is written to your settings.

## Operator commands

Slash commands available once the extension is loaded. The orchestrator's own tool surface (`delegate_task`, `wait_for_agents`, `agent_result`, etc.) is documented in [`docs/prompting.md`](docs/prompting.md); you don't invoke those directly.

| Command | What it does |
|---|---|
| `/team` | Open the keyboard-first dashboard overlay. Top tabs are **Workers / Inspect / Console / Cost**, jump with `1`–`4` (or `tab` / `shift+tab` to cycle). The persistent action bar dispatches `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit` against the selected worker; `s`, `m`, and `n` open an inline single-line modal. Console streams the live worker assistant text from a bounded ring buffer (auto-follow at the tail, `PgUp` to pause, `End` to resume). `/team <worker-id>` jumps straight to that worker's Inspect tab. The header shows a `solo` badge when routing is off; idle workers carry a `[reuse]` tag so you can spot reusable sessions. |
| `/team-copy <worker-id>` | Copy the worker's task, summary, final answer, and console timeline to the clipboard. |
| `/team-prune` | Remove every terminal worker (idle/completed/aborted/error/exited) from the dashboard. |
| `/team-cost` | Per-worker token usage plus a `Σ` aggregate row. Orchestrator usage stays in the Pi footer. |
| `/team-init global\|local [--force]` | Scaffold `agents-team.json` with every built-in role stamped in place, plus the current `schemaVersion` + `scaffoldVersion` markers, the default `routingMode: "team"`, and top-level worker access defaults like `allowPathsOutsideProject: true`. Refuses existing files without `--force`; on `--force` the previous file is copied (not renamed; the original stays put until the new write succeeds) to `YYYY-MM-DD-HHMMSS-agents-team.json` first. |
| `/team-enable global\|local` | Set `enabled: true` in the scoped config file. Run `/reload` to apply. |
| `/team-disable global\|local` | Set `enabled: false` in the scoped config file. The extension stays loaded but goes dormant (no tools, no prompt, no UI) until re-enabled. |
| `/team-off [--persist global\|local]` | Flip routing to **solo** and write `routingMode: "solo"` to the active `agents-team.json` so the choice survives restart. The orchestrator answers directly; `delegate_task` rejects with `Team routing off. Run /team on to delegate.`. Other `agent_*` tools stay live so workers spawned earlier can still be inspected or steered. The widget collapses to a single `Pi Agents Team — solo` line while workers are tracked, and disappears entirely when none are. The persisted target is the winning config layer if one is loaded, otherwise a fresh local stub at `./.pi/agent/agents-team.json`. Pass `--persist global\|local` to force a specific scope. |
| `/team-on [--persist global\|local]` | Flip routing back to **team** and write `routingMode: "team"` to the active `agents-team.json`. Errors with an "enable first" hint when `enabled: false`. Same scope resolution as `/team-off`: winning layer, else fresh local stub; override with `--persist global\|local`. |
| `/agent-result <worker-id>` | Print the compact summary plus the verbatim `<final_answer>` block. |
| `/agent-steer <worker-id\|all> <msg>` | Send a message. Routes by status: `steer` if running, re-`prompt` if idle/waiting_followup (wakes the session). |
| `/agent-followup <worker-id\|all> <msg>` | Queue onto the live stream if running; re-`prompt` if idle/waiting_followup. |
| `/agent-cancel <worker-id\|all>` | Abort one worker, or every non-terminal worker. |
| `/agent-close <worker-id\|all>` | Dispose an idle/waiting_followup worker's RPC session and mark it `exited`. Use this when you're done with a worker and don't want to wait for the next `/team-prune`. Refuses running workers; `/agent-cancel` those instead. |

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
