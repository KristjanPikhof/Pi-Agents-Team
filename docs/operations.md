# Operations guide

## Quick start

Install dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
```

Smoke the runtime and team flow:

```bash
npm run smoke:runtime
npm run smoke:team
```

Load the extension directly:

```bash
pi -e ./extensions/index.ts
```

Run one test file:

```bash
tsx --test tests/runtime/worker-manager.test.ts
```

## Inspect the team

```text
/team
/team <worker-id>
```

- `/team` opens the interactive dashboard overlay in TUI mode, or prints a compact dashboard summary in print mode.
- Top tabs (`1` Workers · `2` Inspect · `3` Console · `4` Cost) are jumped with the number row, or `tab` / `shift+tab` to cycle. The overlay is a single right-anchored stack panel; switch to `Workers` to change selection, then use `Inspect` or `Console` for the selected worker.
- `/team <worker-id>` skips the roster and opens the overlay on that worker's Inspect tab (tab completion suggests live worker ids).

Opening the overlay triggers an active RPC refresh so token counts and streaming status are current. Press `r` inside the overlay to re-ping.

The always-visible footer widget already shows glyphs + counts (`▶ 3 running  ✓ 1 done  ○ 2 idle  ? 1 relay`) plus an inline `Σ` cost column when usage is non-zero — there is no separate "status" slash command.

### Dashboard keys

Inside the `/team` overlay:

| Key | Action |
|---|---|
| `1` / `2` / `3` / `4` | Jump to Workers / Inspect / Console / Cost |
| `tab` / `shift+tab` | Cycle tabs |
| `↑` / `↓` (or `j` / `k`) | Move selection in the roster, or scroll the body of Inspect / Console / Cost |
| `enter` | Open the highlighted worker in Inspect (Workers tab) |
| `PgUp` / `PgDn` | Page scroll. On Console, `PgUp` pauses follow; `End` (or `G`) resumes follow at the tail |
| `g` / `G` | Top / bottom |
| `s` | Steer the selected worker — opens an inline single-line input |
| `m` | Send a message to the selected worker (auto-routes by status) |
| `n` | New task — inline input; uses the selected worker's profile (or the first profile). Always delegates a fresh worker; reuse is orchestrator-only via `delegate_task.reuseWorkerId`. Refused in solo mode |
| `c` | Close (idle / waiting_followup only) — disposes the RPC handle |
| `x` | Cancel — aborts and shuts down a running worker |
| `p` | Prune terminal workers |
| `r` | Re-ping workers (fresh RPC state + stats) |
| `y` | Copy the selected worker's task, summary, final answer, transcript, and console to the clipboard |
| `q` / `esc` | Close overlay (`esc` also cancels a modal) |

The header carries a tab bar, the per-tab help row, and the selected worker's priority snippet. When routing is off, the bar shows a `solo` badge; idle workers carry a `[reuse]` tag in the roster row and `[reusable]` in the Inspect header so reusable sessions are obvious. A transient `» …` status line surfaces last action / refresh / error feedback for a few seconds.

Inspect renders status, task, operator-needs, summary, the worker's `<final_answer>` block, and the latest assistant text in a single scrollable view. Console streams a bounded ring buffer of assistant text deltas (timestamped) per worker, plus the existing console event timeline (status transitions, tool starts and ends, queue updates, errors, exit) under an `— events —` divider. Cost shows a `Σ` aggregate row plus per-worker turns / in / out / cost.

## Inspect a worker's result

```text
/team-result <worker-id>
```

Prints the compact summary (headline, files read/changed, risks, next recommendation, pending relays, usage) plus the verbatim contents of the worker's `<final_answer>` block. This is the authoritative deliverable. If the block is empty, the worker did not follow the contract: re-delegate, steer it with a corrective message, or stop it.

## Clean up finished workers

Press `p` inside the `/team` overlay to prune every terminal worker (`idle`, `completed`, `aborted`, `error`, `exited`) from the dashboard. Useful after a cancelled batch when you want to start fresh without old rows cluttering the widget. Non-terminal workers are left alone, so pruning is safe while new workers are still active.

For a hard reset: `/team-stop all` first to stop every live worker, then `p` in the overlay to clear the terminal rows.

## See aggregate token usage and cost

Open `/team` and press `4` (or cycle to the **Cost** tab) to see one row per tracked worker (turns, input/output tokens, cache reads/writes, cost) plus a `Σ` aggregate row. The orchestrator's own token usage stays in Pi's footer bar (`↑ input ↓ output $cost`), so the Cost tab focuses on the agent team.

The footer widget also shows a compact `Σ turns=… in=… out=… cost=$…` line as soon as any worker has non-zero usage, so you don't have to open the overlay for the running total.

To hide the `Σ` row and Cost tab, set `display.cost: false` in your `agents-team.json`:

```json
{
  "schemaVersion": 4,
  "display": {
    "cost": false
  }
}
```

Defaults to `true` when the field is absent.

## Copy a worker's output to the clipboard

```text
/team-copy <worker-id>
```

Copies a single blob containing the worker's task, compact summary, pending relays, usage, final answer, latest assistant text, and the console timeline (status transitions, tool starts/ends, queue updates, errors, exit). Useful for pasting into an issue or sharing the full worker trace. Inside the `/team` overlay, `y` does the same for the currently focused worker.

Clipboard providers are picked by platform: `pbcopy` on macOS, `clip.exe` on Windows, and `wl-copy` / `xclip` / `xsel` on Linux (first one that works wins). If none are installed, the command prints the failure reason.

## Steer or queue follow-up work

```text
/team-steer <worker-id> narrow to src/runtime only
/team-steer all remember: the user cares about power, not just perf
/team-steer <worker-id> --queue after that, summarize the remaining risks
/team-steer all --queue when you finish, include a risks section
```

`/team-steer` routes by current worker status:

- **Running workers** (actively streaming): sends a mid-stream steer by default. With `--queue`, queues the message onto the live stream so it runs after the current turn. The confirmation line reads `Steered w1 (…:running)` or `Queued follow-up for w1 (…:running)`.
- **Idle / waiting_followup workers** (session alive but not streaming): wakes the session with the message as a fresh user prompt, regardless of whether `--queue` was passed. This is the behavior you want — a bare `follow_up` RPC on an idle session just sits in a pending queue and nothing consumes it, so the worker would otherwise appear to "do nothing". The confirmation line reads `Prompted w1 (…:idle)` to make this explicit.
- **Terminal workers** (`exited`, `aborted`, `error`, `completed`): cannot receive messages and are skipped.

Use `all` to broadcast to every deliverable worker at once. The printed mode is per-worker, so you can see whether each target was steered, queued behind a live stream, or re-prompted.

The orchestrator's `agent_message` tool takes `delivery: "auto" | "steer" | "follow_up"` and follows the same rules. Its tool result text ends with the resolved mode, e.g. `Sent message to w1 (prompt).`

Inside the `/team` overlay, `s` steers the selected worker and `m` sends a message — both defer to the same delivery resolver and only block unreachable terminal workers.

## Stop a worker

```text
/team-stop <worker-id>
/team-stop all
```

Stops one worker or every non-terminal worker. The command automatically picks the right verb:

- **Running / starting** workers: cancels — aborts the RPC session and shuts down the process. State is marked `exited`; persisted state (summary, final answer) survives.
- **Idle / waiting_followup** workers: closes — disposes the RPC session and flips status to `exited`. Use this when a worker is done and you want to free the process immediately rather than waiting for the next prune.
- **Already-terminal** workers (`completed`/`aborted`/`error`/`exited`): refused with a note. Open `/team` and press `p` to remove them from the dashboard.

`all` processes every non-terminal worker in one call and prints a per-worker summary. Per-worker failures don't abort the broadcast.

## Reuse an idle worker

When the next task is the same role, same scope, and same launch settings as an idle worker, the orchestrator can pass that worker's id as `delegate_task.reuseWorkerId` instead of spawning a fresh process. Reuse re-prompts the existing RPC session, allocates a fresh `taskId`, and resets per-task state (summary, `<final_answer>`, last tool, relay questions). The result: warm role context survives, spawn cost is skipped.

`agent_status` reports `reusable: true` on workers in `idle` or `waiting_followup`. Anything else has either no live session (`completed`/`aborted`/`error`/`exited`) or work in flight (`running`/`starting`); reuse fails fast with a per-status hint.

What blocks reuse:

| Mismatch | Why |
|---|---|
| Different `profileName` | Different role, different prompt; spawn fresh. |
| Different `model`, `tools`, `cwd`, `systemPromptPath`, `extensionMode`, `thinkingLevel`, or `skills` presence | Baked into the worker process at spawn. The RPC can't change them mid-life. |
| Status not `idle`/`waiting_followup` | RPC session disposed or busy. |

When reuse rejects, the error spells out which fields differ. The fix is usually to either align the request or drop `reuseWorkerId` and let a fresh worker spawn.

## Toggle routing without reload

`/team-enable on` and `/team-enable off` flip orchestrator behavior live. No `/reload` needed, and the choice sticks across restarts because the command writes `routingMode` to the active `agents-team.json` by default.

```text
/team-enable off                       # solo, persist to the active config file
/team-enable off --persist local       # force write to ./.pi/agent/agents-team.json
/team-enable on                        # back to team, persist to the active config file
/team-enable on --persist global       # force write to ~/.pi/agent/agents-team.json
```

What changes in **solo** mode:

- `delegate_task` rejects with `Team routing off. Run /team-enable on to delegate.`. The orchestrator prompt drops the profile catalog and gets a one-line directive telling it to answer directly.
- The widget collapses to a single `Pi Agents Team — solo` line when workers are tracked, or hides entirely when none are. The status line keeps the badge either way.
- `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, and `agent_cancel` stay live so workers spawned earlier can still be inspected, steered, or shut down.

How the persistence target is resolved when you don't pass `--persist`:

1. A winning `agents-team.json` is loaded (project file present, or global if no project file) → patch its `routingMode` field in place. `roles`, `enabled`, `workerAccess` stay untouched.
2. No config file anywhere → create a minimal local stub at `<cwd>/.pi/agent/agents-team.json` containing only `schemaVersion` and `routingMode`. Built-in role defaults still apply.

`--persist global|local` overrides the resolver and always writes to that scope, even when a different layer is winning. Use it when you want to flip `routingMode` for a different scope than the one currently in effect (for example, set the global default while a project file overrides it locally).

Write semantics: atomic (`<file>.tmp.<pid>.<ts>` then `renameSync`), shallow-merged into the existing JSON so other fields survive. A schema-mismatched but parseable file is patched anyway with a warning toast; an unparseable file errors out without touching the in-memory toggle.

When a fresh session boots, the initial `routingMode` falls out of the same config:

| Config state | Initial routingMode |
|---|---|
| `enabled: false` or invalid (delegation off) | `solo` |
| `enabled: true`, no persisted `routingMode` | `team` |
| `enabled: true`, persisted `routingMode: "solo"` | `solo` |
| `enabled: true`, persisted `routingMode: "team"` | `team` |

`/team-enable on` errors with an "enable first" hint when `enabled: false`. Edit `agents-team.json` to set `enabled: true`, then `/reload`; routing toggles only mean something when delegation itself is on.

## Delegation notes

The orchestrator-facing tool is `delegate_task`. In normal use you do not type the tool call yourself: ask the orchestrator for the work and it decides when to delegate.

The orchestrator may answer directly for trivial, already-known, or tiny bounded checks. It should delegate investigation, review, mapping, tests, and multi-file work to background workers.

If a profile can write files (today, only `fixer`), provide an explicit writable path scope. Launch policy rejects write-capable tasks without one.

By default, delegated path scopes may include `/tmp`, sibling repos, or other absolute paths. If you need to restrict delegated worker scopes to the discovered project root / current cwd, opt out via `agents-team.json`:

```json
"workerAccess": {
  "allowPathsOutsideProject": false
}
```

That only restricts delegated worker path-scope containment. The main orchestrator session and worker prompt-file containment are unchanged; prompt files must remain inside the project/current cwd.

The orchestrator should pair every `delegate_task` with a `wait_for_agents` call, then `agent_result` per worker, and synthesize a single answer. It should not loop `ping_agents`, should not sleep in bash, and should not run investigation tools itself while workers are active. See [`../prompts/orchestrator.md`](../prompts/orchestrator.md).

## Mid-flight relay handling

`wait_for_agents` now wakes up early when any target raises a new relay question while others are still running (`wakeOnRelay: true` by default). When that happens the tool returns `reason: "relay_raised"` and `details.newRelays` lists which worker raised what.

The orchestrator's pattern:

```
wait_for_agents          ← asleep, zero tokens
  ↑                        returns "relay_raised" + newRelays list
  │
  │  agent_message (answer the relay)
  │
  └─ wait_for_agents     ← back to sleep
```

Each call re-snapshots the baseline relay count, so an already-answered relay never wakes a subsequent wait. Only fresh relays do. The orchestrator keeps cycling until every worker reaches a terminal status (`reason: "all_terminal"`).

Pass `wakeOnRelay: false` if you explicitly want the old "wait for everyone" behavior.

## Troubleshooting

### `agents-team.json` changes do not apply to a running session

Expected. Project role config is discovered once on session start, then treated as session-frozen runtime state. Reload/restart the Pi session after editing `agents-team.json` or any project prompt file it references.

### Delegation is disabled because `agents-team.json` is invalid

Expected when the project role config hits a hard error. The extension warns on session start, adds a prompt note telling the orchestrator delegation is disabled, and rejects `delegate_task` until the file is fixed.

Common causes (hard errors):

- The JSON isn't parseable (syntax error).
- A prompt path escapes the project root.
- A `pathScope` root escapes the project root while `workerAccess.allowPathsOutsideProject` is explicitly `false`.
- A role declares `access.extensionMode: "inherit"` (recursion guard).

Soft warnings don't disable delegation (the config keeps working):

- `schemaVersion` doesn't match the current schema. The layer falls back to built-ins and you get a toast pointing at `/team-init --force`. See [`profiles.md`](profiles.md) "Version bumps."
- A prompt string that doesn't resolve to a file. It gets treated as inline prompt text, which is usually what you want. If you actually meant a path, fix the typo.

See [`profiles.md`](profiles.md) for the full role shape and prompt-resolution rules.

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch.

### A worker is restored after reload but not actually running

Expected. Persisted workers are force-marked `exited` on restore so the operator sees what existed before the reload without being misled about process liveness.

On a warm session start (`reload`, `resume`, `fork`, `new`), a one-line warning toast announces how many workers were flipped and the session-start reason. Example: `Pi Agents Team: 3 workers from prior session marked exited (resume). Relaunch via delegate_task if still needed.` Cold `startup` keeps the original info toast (`Pi Agents Team loaded…`). Each flipped worker's `error` field carries a reason-specific message (`session resumed…`, `session forked…`), which surfaces in `/team` detail view and copy payloads.

### `/team-steer` "seems queued but nothing happens"

Look at the confirmation line: if it says `Prompted w<id> (…:idle)`, the worker was re-prompted and will start streaming again on its next event tick. If it says `Queued follow-up for w<id> (…:running)`, the message is sitting behind the live stream and will run after the current turn. Only terminal workers (`exited`, `aborted`, `error`, `completed`) refuse messages outright. A bare `follow_up` RPC against an idle Pi session only queues without waking it — the router upgrades that case to a full prompt automatically, so you don't need `--queue` for idle workers.

### A write-capable worker is rejected

Launch policy is doing its job. `fixer` requires an explicit writable `pathScope`. Either provide one on the delegated task or switch to a read-only profile like `explorer`, `reviewer`, or `oracle`.

### Routing toggle fails with "enable first"

`/team-enable on` requires `enabled: true` in `agents-team.json`. If delegation is turned off, edit the file manually to set `enabled: true` and run `/reload`. Routing toggles only take effect when delegation itself is on.

### `agent_result` returns an empty `<final_answer>`

The worker finished but did not follow the contract. Three moves, in order of preference: re-delegate with smaller slices, steer the existing worker with `/team-steer <id> <corrective message>` asking it to re-issue the final answer, or stop and re-spawn with a better brief. Do not fall back to running `bash`/`read`/`grep` yourself.

### "Worker finished" toast fired, but the worker is still running

Fixed. The `starting → idle` race has a guard in `applyNormalizedEvent` (worker stays `starting` until actually prompted) plus a filter in `flushTerminalNotifications` that drops entries whose status has flipped back off-terminal by flush time. If you see this again, it is a real bug: check `src/runtime/worker-manager.ts` and the `onStateChange` listener in the internal implementation entrypoint (`extensions/pi-agent-team/index.ts`).

## Local verification commands

```bash
npm run typecheck
npm test
pi -e ./extensions/index.ts -p "/team"
```

That smoke command exercises the shipped package entrypoint in the same mode operators use: an overlay-style, keyboard-first panel in TUI environments, with a compact text fallback when no UI is available.
