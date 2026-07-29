# Pi Agents Team

Pi main session acts as the coordinator, while background RPC workers execute the tasks. The orchestrator does not view complete transcripts from the workers, receiving only concise summaries and one `<final_answer>` block per worker. Meanwhile, the user can monitor cost, tokens, active workers, readable Activity, Raw diagnostics, and the retained/latest assistant-text tail.

<p align="center">
  <img width="auto" height="900" alt="pi-agents-team" src="https://github.com/user-attachments/assets/5dd744c3-3fef-4c9c-9e1a-29443f0570bb" />

</p>

- **Repo:** [`git@github.com:KristjanPikhof/pi-agents-team.git`](https://github.com/KristjanPikhof/Pi-Agents-Team)
- **Requires:** Pi ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) `>=0.80.6`, Node `>=22.19.0`, and Git. npm and `package-lock.json` are the authoritative dependency workflow for this repository.

## Install

Install the published package from npm:

```bash
pi install npm:pi-agents-team
```

`pi install` persists the package source in your Pi settings, so future sessions load it automatically. For project-local package activation, run:

```bash
pi install -l npm:pi-agents-team
```

Use `pi config -l` only to enable or disable local packages or override local resources. Package activation is separate from `<project>/.pi/agent/agents-team.json`, which configures team roles after the package is active.

To try the extension for one run without writing settings, launch Pi with `-e` instead:

```bash
pi -e npm:pi-agents-team
```

The npm package ships native ESM JavaScript and TypeScript declarations. Its package export and Pi extension entry both resolve to `dist/extensions/index.js`; the packaged prompts and profiles also live under `dist/`. Direct Git package installs are not supported because `dist/` is ignored in the repository and Pi's Git install flow does not build it.

### Run a local checkout

Use the TypeScript entrypoint when developing from source:

```bash
git clone git@github.com:KristjanPikhof/pi-agents-team.git
cd pi-agents-team
npm install
pi -e ./extensions/index.ts
```

Pi loads this local-development shim through `jiti`, so a build is not required before each run. This checks the source path only; it does not validate the compiled or published package entrypoint. Validate those paths separately:

```bash
npm run build
npx tsx --test tests/package-manifest.test.ts tests/package-publish.test.ts
```

The focused package tests check the `dist/` manifest contract, run `npm pack`, install the tarball offline, and import it from a clean consumer.

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

## Session persistence and recovery

Pi Agents Team writes compact worker transitions to Pi's append-only JSONL session. It persists bounded worker/profile identity, terminal status and timestamps, compact summaries, and Pi-reported usage. Task metadata, prompts, paths, relays, final answers, transcripts, stream deltas, activity/tool output, process IDs, raw runtime errors, and lifecycle guards stay out of the persisted payload.

Runtime churn and timestamp-only refreshes add no records. A terminal transition or substantive terminal summary/usage revision writes a v2 `worker_terminal` record; prune writes `worker_pruned`. Each compact record is at most 16 KiB of serialized UTF-8, with Unicode-safe trimming. Reload replays the active branch only, deduplicates records by ID, ignores malformed or future entries, and reads legacy v1 state through the compact allowlist. Restored live or reusable workers become `exited` because their RPC processes are not attached, while saved summaries and authoritative usage remain available.

**Storage warning:** Pi session JSONL is append-only. Reload, prune, tree navigation, and fork do not physically shrink the session file. At 10,000 recognized compact records or 64 MiB of compact payloads on the active branch, the extension warns once and recommends a genuinely new session. To reclaim disk space, start a new session or perform an offline migration while Pi is stopped. This release does not repair existing multi-gigabyte legacy sessions, which may be unsafe to resume. See [operations](https://github.com/KristjanPikhof/Pi-Agents-Team/blob/main/docs/operations.md#manage-persisted-session-growth) for the recovery procedure and measurement details.

## How it works (in a nutshell)

The orchestrator may answer trivial, already-known or tiny bounded asks directly; substantial investigation, review, mapping, tests, and multi-file work goes to background workers. 

For delegated work, the orchestrator **picks a role** from the loaded config (seven [built-ins](https://github.com/KristjanPikhof/Pi-Agents-Team/tree/main/prompts/agents) by default: explorer, fixer, reviewer, librarian, observer, oracle, designer) and calls `delegate_task`. The runtime spawns `pi --mode rpc --no-session` and feeds the worker its role prompt plus a task prompt that requires the final reply to wrap the deliverable in a `<final_answer>…</final_answer>` block. If `delegate_task.skills` names installed Pi skills, worker skill discovery is enabled and the worker is told to load and apply those requested skill names from its available skill context.

Roles can also declare `access.extensions` when a worker needs a custom provider/model extension. The default `worker-minimal` launch disables ambient extension discovery with `--no-extensions`, then passes each explicit source with Pi `--extension`/`-e`, so a model such as `myAnthropic/claude-opus-4-7` can be made available without loading the full orchestrator into the worker.

`delegate_task` shows a launch title such as `Launching fixer agent` (or `Reusing fixer agent (w1)` for warm reuse), then returns one compact receipt line such as `w1 · Build seam (t1)`.

Worker RPC events get normalized into compact in-memory state: status, last tool, last summary, pending relay questions, token usage, known context budget, and a bounded Activity stream. `agent_end` marks the end of a model loop but is not completion; a worker becomes successfully idle, result-ready, and reusable only when Pi emits `agent_settled`. Console shows the Activity stream by default as Pi-themed blocks such as `╭─ tool bash [ok]` followed by a `$ npm run typecheck` command line, nested output snippets, and explicit elision like `… +14 lines hidden`; Raw remains available for debugging. In Console, `r` toggles Activity and Raw; outside Console, `r` refreshes worker state. Tool status and git-style `+` / `-` output use the active Pi theme roles while keeping plain-text markers for copies. Worker-controlled terminal text is sanitized before render/copy surfaces. Inspect summarizes the same source under `Recent activity`. Copy payloads put `## Activity` before `## Console timeline (Raw)` and show a retained assistant-text tail with an explicit truncation note when line or byte caps are hit. Raw transcripts/events are not persisted or used as a synthesis fallback.

Subagent reuse is context-aware: same-scope idle workers are cheap below 50% context window, fresh workers are preferred above 70%, and reuse is rejected at or above 80% context or at/below 32768 remaining tokens. The orchestrator waits with `wait_for_agents` (zero-token wait, wakes early on relay questions by subagents), responds to relay wakes with `agent_message` and another `wait_for_agents`, reads each worker's `agent_result`, and synthesizes one user-facing answer. Waits remain active through intermediate `agent_end` events and finish successfully only after `agent_settled`. `wait_for_agents` returns human-readable outcomes such as `Wait: all agents finished`, `Wait: relay question raised`, `Wait: timeout`, `Wait: aborted`, or `Wait: no agents` with a `Next:` instruction. `agent_result` is the authoritative worker deliverable: a compact title/task/relay/summary wrapper plus the verbatim `<final_answer>` block, or an explicit missing-block message when no final answer was extracted. Worker transcripts are not persisted or used as a fallback synthesis source.

Optional config lives at `~/.pi/agent/agents-team.json` (global) and/or `<project>/.pi/agent/agents-team.json` (nearest ancestor of cwd). Project-local config is ignored until Pi reports that the current project is trusted; global config and built-ins still work. Once trusted, the project file fully replaces global; nothing merges across layers. Role names are free-form, so you can **rename the seven defaults**, **drop the ones you don't need** or **add your own**. Top-level controls include `enabled: false` (dormant mode) and `workerAccess.allowPathsOutsideProject: false` (restrict delegated worker path scopes to the project root/current cwd; prompt-file containment remains unchanged). Use `/team-init` to scaffold a config file and `/team-enable on|off` to toggle routing without editing JSON.

Path-shaped role prompts must resolve to regular files; otherwise the active config is invalid and delegation stays disabled. Prose-shaped prompt strings remain available for intentional inline prompts.

Tip: `/team-init local` writes the packaged role defaults (`explorer`/`observer`: `low`, `oracle`/`reviewer`: `high`, `designer`/`fixer`/`librarian`: `medium`) rather than your current live Pi thinking level. `max` is available as an explicit opt-in when the selected Pi model/provider supports it; Pi may clamp it to a lower effective level. Existing defaults, schema/scaffold versions, and config files do not change or regenerate automatically. Delete a role's `thinkingLevel` when you want that role to inherit through the launch cascade instead. Do not write `"thinkingLevel": "default"` or `""`; both are invalid and get dropped with a warning.

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
