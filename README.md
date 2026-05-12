# Pi Agents Team

One Pi session orchestrates. Background RPC workers do the work. The orchestrator never sees worker transcripts, only compact summaries and a single `<final_answer>` block per worker.

**Repo:** `git@github.com:KristjanPikhof/pi-agents-team.git`
**Requires:** `pi` CLI ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) `>=0.74.0`, Node `>=20`, Git.

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
| `/team` | Open the keyboard-first dashboard overlay. Top tabs are **Workers / Inspect / Console / Cost**, jump with `1`–`4` (or `tab` / `shift+tab` to cycle). The persistent action bar dispatches `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit` against the selected worker; `s`, `m`, and `n` open an inline single-line modal. Console streams the live worker assistant text from a bounded ring buffer (auto-follow at the tail, `PgUp` to pause, `End` to resume). Cost remains the worker usage/cost view and uses compact token labels (`k` = thousands / 1,000; `m` = millions / 1,000,000) for input/output counts. `/team <worker-id>` jumps straight to that worker's Inspect tab. The header shows a `solo` badge when routing is off; idle workers carry a `[reuse]` tag so you can spot reusable sessions. |
| `/team-steer <id\|all> <message> [--queue]` | Send a message to one worker or broadcast to all. Routes by current status: `steer` if running, re-`prompt` to wake idle/waiting_followup. `--queue` forces `follow_up` delivery for running workers (message runs after current turn); idle/waiting workers still upgrade to a fresh prompt so the session wakes. |
| `/team-stop <id\|all>` | Stop one worker or every non-terminal worker. Auto-picks the right verb: `cancel` for running/starting, `close` for idle/waiting_followup. Already-terminal workers are skipped with a note; use overlay `[p]` to remove them. |
| `/team-copy <id>` | Copy the worker's task, summary, final answer, and console timeline to the clipboard. |
| `/team-result <id>` | Print the compact summary (headline, files, risks, usage) plus the verbatim `<final_answer>` block. Usage token counts may be compacted with `k` for thousands (1,000) and `m` for millions (1,000,000). The authoritative worker deliverable. |
| `/team-enable on\|off [--persist global\|local]` | Flip routing between **team** and **solo** and write `routingMode` to the active `agents-team.json` so the choice survives restart. In solo mode the orchestrator answers directly; `delegate_task` rejects with a routing-off error. Other `agent_*` tools stay live so workers spawned earlier remain reachable. The widget collapses to a single `Pi Agents Team — solo` line while workers are tracked, and disappears entirely when none are. Pass `--persist global\|local` to force a specific scope; default resolves the winning config layer, falling back to a fresh local stub at `./.pi/agent/agents-team.json`. `/team-enable on` errors with an "enable first" hint when `enabled: false`. |
| `/team-init [global\|local] [--force]` | Scaffold `agents-team.json` with every built-in role stamped in place, including each role's default `thinkingLevel`, plus the current `schemaVersion` + `scaffoldVersion` markers, the default `routingMode: "team"`, and top-level worker access defaults like `allowPathsOutsideProject: true`. Refuses existing files without `--force`; on `--force` the previous file is backed up first. |

## How it works (in one paragraph)

The orchestrator may answer trivial, already-known, or tiny bounded asks directly; substantial investigation, review, mapping, tests, and multi-file work goes to background workers. For delegated work, the orchestrator picks a role from the loaded config (seven built-ins by default: explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. If `delegate_task.skills` names installed Pi skills, worker skill discovery is enabled and the worker is told to load and apply those requested skill names from its available skill context. Worker RPC events get normalized into compact state: status, last tool, last summary, pending relay questions, token usage. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions), reads each worker's `agent_result`, and synthesizes one user-facing answer. Optional config lives at `~/.pi/agent/agents-team.json` (global) and/or `<project>/.pi/agent/agents-team.json` (nearest ancestor of cwd). The project file, if present, fully replaces global; nothing merges across layers. Role names are free-form, so you can rename the seven defaults, drop the ones you don't need, or add your own. Top-level controls include `enabled: false` (dormant mode) and `workerAccess.allowPathsOutsideProject: false` (restrict delegated worker path scopes to the project root/current cwd; prompt-file containment remains unchanged). Use `/team-init` to scaffold a config file and `/team-enable on|off` to toggle routing without editing JSON.

Tip: `/team-init local` writes the packaged role defaults (`explorer: low`, `oracle: high`, most other roles `medium`) rather than your current live Pi thinking level. Delete a role's `thinkingLevel` when you want that role to inherit through the launch cascade instead. Do not write `"thinkingLevel": "default"` or `""`; both are invalid and get dropped with a warning.

Config freshness warnings are based on the active config layer only: project-local wins by file presence, otherwise global, otherwise no file. A stale or missing active `scaffoldVersion` produces a soft boot warning and the file keeps loading; refresh explicitly with `/team-init <local|global> --force` (backs up first).

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
