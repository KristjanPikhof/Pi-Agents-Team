# Pi Agents Team

Pi main session acts as the coordinator, while background RPC workers execute the tasks. The orchestrator does not view complete transcripts from the workers, receiving only concise summaries and one `<final_answer>` block per worker. Meanwhile, the user can monitor cost, tokens, active workers, readable Activity, Raw diagnostics, and the retained/latest assistant-text tail.

<p align="center">
  <img width="auto" height="900" alt="pi-agents-team" src="https://github.com/user-attachments/assets/5dd744c3-3fef-4c9c-9e1a-29443f0570bb" />

</p>

- **Repo:** [`git@github.com:KristjanPikhof/pi-agents-team.git`](https://github.com/KristjanPikhof/Pi-Agents-Team)
- **Requires:** pi ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) `>=0.79.2`, Node `>=22.19.0`, Git. Pi `0.79.2+` enables Project Trust-aware config loading, worker trust propagation, cache metrics, natural `@worker` / `$role` autocomplete, and custom provider/model resolution for worker-launched extensions.

## Install

Install from npm:

```bash
pi install npm:pi-agents-team
```

`pi install` persists the package source in your Pi settings, so future sessions load it automatically. To try the extension for one run without writing settings, launch Pi with `-e` instead:

```bash
pi -e npm:pi-agents-team
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

## Operator commands

Slash commands available once the extension is loaded. The orchestrator's own tool surface (`delegate_task`, `wait_for_agents`, `agent_result`, etc.) is documented in [prompting](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/prompting.md); you don't invoke those directly. See [operations](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/operations.md) for dashboard keys, copy output, steer semantics, and troubleshooting.

| Command | What it does |
|---|---|
| `/team [worker-id]` | Open the live dashboard. Tabs cover Workers, Inspect, Console, and Cost; `/team <worker-id>` opens Inspect for that worker in TUI sessions. RPC/non-TUI sessions print a summary dashboard instead. |
| `/team-steer <id\|all> [--queue] <message>` | Message one worker or broadcast to all. Running workers receive `steer` by default; `--queue` sends the message after the current turn. Idle or waiting workers are woken with a fresh prompt. |
| `/team-stop <id\|all>` | Stop one worker or every non-terminal worker. Running/starting workers are canceled, idle/waiting workers are closed, and terminal workers are skipped. |
| `/team-copy <id>` | Copy task, summary, final answer, retained assistant tail, Activity, and Raw diagnostics to the clipboard. |
| `/team-result <id>` | Print the transcript-free worker result and verbatim `<final_answer>` contents when available. |
| `/team-enable on\|off [--local\|--global]` | Toggle routing between **team** and **solo**. Without a flag the change is session-only; `--local` or `--global` persists `routingMode` to that config scope. |
| `/team-init [global\|local] [--force]` | Scaffold `agents-team.json` with built-in roles, schema/scaffold markers, default routing, and worker access defaults. Existing files require `--force`, which backs up the previous file first. |

In TUI sessions that support editor autocomplete, type `@` to complete tracked workers (`@w1`) and `$` to complete configured roles (`$reviewer`) while writing prompts or command arguments.

## How it works (in a nutshell)

The orchestrator may answer trivial, already-known or tiny bounded asks directly; substantial investigation, review, mapping, tests, and multi-file work goes to background workers. 

For delegated work, the orchestrator **picks a role** from the loaded config (seven [built-ins](https://github.com/KristjanPikhof/Pi-Agents-Team/tree/main/prompts/agents) by default: explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. If `delegate_task.skills` names installed Pi skills, worker skill discovery is enabled and the worker is told to load and apply those requested skill names from its available skill context.

Roles can also declare `access.extensions` when a worker needs a custom provider/model extension. The default `worker-minimal` launch disables ambient extension discovery with `--no-extensions`, then passes each explicit source with Pi `--extension`/`-e`, so a model such as `myAnthropic/claude-opus-4-7` can be made available without loading the full orchestrator into the worker.

`delegate_task` shows a launch title such as `Launching fixer agent` (or `Reusing fixer agent (w1)` for warm reuse), then returns one compact receipt line such as `w1 · Build seam (t1)`.

Worker RPC events get normalized into compact state: status, last tool, last summary, pending relay questions, token usage, known context budget, and a bounded in-memory Activity stream. Console shows the Activity stream by default as Pi-themed blocks such as `╭─ tool bash [ok]` followed by a `$ npm run typecheck` command line, nested output snippets, and explicit elision like `… +14 lines hidden`; Raw remains available for debugging. In Console, `r` toggles Activity and Raw; outside Console, `r` refreshes worker state. Tool status and git-style `+` / `-` output use the active Pi theme roles while keeping plain-text markers for copies. Worker-controlled terminal text is sanitized before render/copy surfaces. Inspect summarizes the same source under `Recent activity`. Copy payloads put `## Activity` before `## Console timeline (Raw)` and show a retained assistant-text tail with an explicit truncation note when line or byte caps are hit. Raw transcripts/events are not persisted or used as a synthesis fallback.

Subagent reuse is context-aware: same-scope idle workers are cheap below 50% context window, fresh workers are preferred above 70%, and reuse is rejected at or above 80% context or at/below 32768 remaining tokens. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions by subagents), responds to relay wakes with `agent_message` and another `wait_for_agents`, reads each worker's `agent_result`, and synthesizes one user-facing answer. `wait_for_agents` returns human-readable outcomes such as `Wait: all agents finished`, `Wait: relay question raised`, `Wait: timeout`, `Wait: aborted`, or `Wait: no agents` with a `Next:` instruction. `agent_result` is the authoritative worker deliverable: a compact title/task/relay/summary wrapper plus the verbatim `<final_answer>` block, or an explicit missing-block message when no final answer was extracted. Worker transcripts are not persisted or used as a fallback synthesis source.

Optional config lives at `~/.pi/agent/agents-team.json` (global) and/or `<project>/.pi/agent/agents-team.json` (nearest ancestor of cwd). On Pi versions with Project Trust, project-local config is ignored until the current project is trusted; global config and built-ins still work. Once trusted, the project file fully replaces global; nothing merges across layers. Role names are free-form, so you can **rename the seven defaults**, **drop the ones you don't need** or **add your own**. Top-level controls include `enabled: false` (dormant mode) and `workerAccess.allowPathsOutsideProject: false` (restrict delegated worker path scopes to the project root/current cwd; prompt-file containment remains unchanged). Use `/team-init` to scaffold a config file and `/team-enable on|off` to toggle routing without editing JSON.

Tip: `/team-init local` writes the packaged role defaults (`explorer`/`observer`: `low`, `oracle`/`reviewer`: `high`, `designer`/`fixer`/`librarian`: `medium`) rather than your current live Pi thinking level. Delete a role's `thinkingLevel` when you want that role to inherit through the launch cascade instead. Do not write `"thinkingLevel": "default"` or `""`; both are invalid and get dropped with a warning.

Config freshness warnings are based on the active config layer only: project-local wins by file presence, otherwise global. A stale or missing active `scaffoldVersion` produces a soft boot warning and the file keeps loading; refresh explicitly with `/team-init <local|global> --force` (backs up first).

## Documentation

| File | Covers |
|---|---|
| [Architecture](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/architecture.md) | Layering, runtime flow, state contract, animation layer. |
| [Operations](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/operations.md) | Install, dashboard keys, copy flow, steer semantics, troubleshooting. |
| [Profiles](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/profiles.md) | Default roles, how to create your own, prompt resolution, project vs global config, version bumps, launch-time safety. |
| [Prompting](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/prompting.md) | Orchestrator + worker prompt contracts, the `<final_answer>` rules. |
| [Contributing](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/CONTRIBUTING.md) | Local dev setup, tests, smoke scripts, package layout. |
| [Claude notes](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/CLAUDE.md) | Load-bearing invariants and anti-patterns. Read before touching state transitions. |

## License

[MIT](LICENSE). Copyright © 2026 Kristjan Pikhof.
