# Pi Agents Team

Pi main session acts as the coordinator, while background RPC workers execute the tasks. The orchestrator does not view the complete transcripts from the workers, receiving only concise summaries and one `<final_answer>` block per worker. Meanwhile, the user is able to monitor the cost, tokens used, active workers and their full transcripts.

<p align="center">
  <img width="auto" height="900" alt="pi-agents-team" src="https://github.com/user-attachments/assets/39fedc42-4097-4b79-932e-2eba0e06c07e" />
</p>

- **Repo:** [`git@github.com:KristjanPikhof/pi-agents-team.git`](https://github.com/KristjanPikhof/Pi-Agents-Team)
- **Requires:** pi ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) `>=0.74.0`, Node `>=20`, Git.

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
| `/team` | Open the keyboard-first dashboard overlay: this is the full live worker registry, not just currently running workers. Tabs are **Workers / Inspect / Console / Cost**; jump with `1`–`4`, or cycle with `tab` / `shift+tab`. The action bar runs `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit` for the selected worker. Inspect renders status, task/operator needs, summary, final answer, and latest assistant text as readable sections; Console groups assistant text separately from timestamped events. Both preserve common Markdown-like headings, tables, lists, and indented/code-like lines while wrapping to the panel width. Inspect and Console support follow mode with `f` (`G` jumps bottom + follows, `g` jumps top); Mac-friendly paging uses `space` / `b` in addition to `PgDn` / `PgUp`. Their compact header shows either `[follow]` or `[paused f/G]` plus the visible row range. Cost shows per-worker usage for currently tracked workers, plus `Σ` totals for active workers and usage retained from pruned terminal workers. The footer widget retains recent terminal worker rows briefly, and pruning clears old rows without resetting team token/cost totals. `/team <worker-id>` opens that worker's Inspect tab. The header shows `solo` when routing is off, and idle workers show `[reuse]`. |
| `/team-steer <id\|all> <message> [--queue]` | Send a message to one worker or broadcast to all. Routes by current status: `steer` if running, re-`prompt` to wake idle/waiting_followup. `--queue` forces `follow_up` delivery for running workers (message runs after current turn); idle/waiting workers still upgrade to a fresh prompt so the session wakes. |
| `/team-stop <id\|all>` | Stop one worker or every non-terminal worker. Auto-picks the right verb: `cancel` for running/starting, `close` for idle/waiting_followup. Already-terminal workers are skipped with a note; use overlay `[p]` to remove them. |
| `/team-copy <id>` | Copy the worker's task, summary, final answer, and console timeline to the clipboard. |
| `/team-result <id>` | Print a transcript-free worker result: worker title, optional task/status/error, pending relay questions, and `Result:` followed by the verbatim `<final_answer>` contents (or `No final answer block extracted yet.`). It does not print or depend on the worker transcript. The `agent_result` tool may additionally include scan-friendly summary sections for orchestrator synthesis. |
| `/team-enable on\|off [--persist global\|local]` | Flip routing between **team** and **solo** and write `routingMode` to the active `agents-team.json` so the choice survives restart. In solo mode the orchestrator answers directly; `delegate_task` rejects with a routing-off error. Other `agent_*` tools stay live so workers spawned earlier remain reachable. The widget collapses to a single `Pi Agents Team — solo` line while workers are tracked, and disappears entirely when none are; the bottom status line shows solo explicitly (`Orchestrator · Solo · Idle` / `Orchestrator · Solo · Working...`) plus a rotating tip such as `Tip: Use /team to view workers`. Pass `--persist global\|local` to force a specific scope; default resolves the winning config layer, falling back to a fresh local stub at `./.pi/agent/agents-team.json`. `/team-enable on` errors with an "enable first" hint when `enabled: false`. |
| `/team-init [global\|local] [--force]` | Scaffold `agents-team.json` with every built-in role stamped in place, including each role's default `thinkingLevel`, plus the current `schemaVersion` + `scaffoldVersion` markers, the default `routingMode: "team"`, and top-level worker access defaults like `allowPathsOutsideProject: true`. Refuses existing files without `--force`; on `--force` the previous file is backed up first. |

## How it works (in a nutshell)

The orchestrator may answer trivial, already-known or tiny bounded asks directly; substantial investigation, review, mapping, tests, and multi-file work goes to background workers. 

For delegated work, the orchestrator **picks a role** from the loaded config (seven [built-ins](https://github.com/KristjanPikhof/Pi-Agents-Team/tree/main/prompts/agents) by default: explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. If `delegate_task.skills` names installed Pi skills, worker skill discovery is enabled and the worker is told to load and apply those requested skill names from its available skill context.

`delegate_task` shows a launch title such as `Launching fixer agent` (or `Reusing fixer agent (w1)` for warm reuse), then returns one compact receipt line such as `w1 · Build seam (t1)`.

Worker RPC events get normalized into compact state: status, last tool, last summary, pending relay questions, token usage, and known context budget.

Subagent reuse is context-aware: same-scope idle workers are cheap below 50% context window, fresh workers are preferred above 70%, and reuse is rejected at or above 80% context or at/below 32768 remaining tokens. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions by subagents), responds to relay wakes with `agent_message` and another `wait_for_agents`, reads each worker's `agent_result`, and synthesizes one user-facing answer. `wait_for_agents` returns human-readable outcomes such as `Wait: all agents finished`, `Wait: relay question raised`, `Wait: timeout`, `Wait: aborted`, or `Wait: no agents` with a `Next:` instruction. `agent_result` is the authoritative worker deliverable: a compact title/task/relay/summary wrapper plus the verbatim `<final_answer>` block, or an explicit missing-block message when no final answer was extracted. Worker transcripts are not persisted or used as a fallback synthesis source.

Optional config lives at `~/.pi/agent/agents-team.json` (global) and/or `<project>/.pi/agent/agents-team.json` (nearest ancestor of cwd). The project file, if present, fully replaces global; nothing merges across layers. Role names are free-form, so you can **rename the seven defaults**, **drop the ones you don't need** or **add your own**. Top-level controls include `enabled: false` (dormant mode) and `workerAccess.allowPathsOutsideProject: false` (restrict delegated worker path scopes to the project root/current cwd; prompt-file containment remains unchanged). Use `/team-init` to scaffold a config file and `/team-enable on|off` to toggle routing without editing JSON.

Tip: `/team-init local` writes the packaged role defaults (`explorer: low`, `oracle: high`, most other roles `medium`) rather than your current live Pi thinking level. Delete a role's `thinkingLevel` when you want that role to inherit through the launch cascade instead. Do not write `"thinkingLevel": "default"` or `""`; both are invalid and get dropped with a warning.

Config freshness warnings are based on the active config layer only: project-local wins by file presence, otherwise global. A stale or missing active `scaffoldVersion` produces a soft boot warning and the file keeps loading; refresh explicitly with `/team-init <local|global> --force` (backs up first).

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
