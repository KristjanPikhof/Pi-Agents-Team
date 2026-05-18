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

- `/team` opens the interactive dashboard overlay in TUI mode, or prints a compact dashboard summary in print mode. Treat it as the full live worker registry: running, queued, idle/reusable, recent terminal, error, and retained-cost state are all reachable there rather than through separate status commands.
- Top tabs (`1` Workers · `2` Inspect · `3` Console · `4` Cost) are jumped with the number row, or `tab` / `shift+tab` to cycle. The overlay is a single right-anchored stack panel; switch to `Workers` to change selection, then use `Inspect` or `Console` for the selected worker.
- `/team <worker-id>` skips the roster and opens the overlay on that worker's Inspect tab (tab completion suggests live worker ids).

Opening the overlay triggers an active RPC refresh so token counts and streaming status are current. Press `r` inside the overlay to re-ping.

The always-visible footer widget already shows glyphs + counts (`▶ 3 running  ✓ 1 done  ○ 2 idle  ? 1 relay`) plus an inline `Σ` cost column when active or retained-pruned usage is non-zero — there is no separate "status" slash command. Active rows display task elapsed time (using the current task start on reused workers); recent terminal rows are retained for five minutes so finishes remain visible until the operator opens `/team` or prunes them.

### Dashboard keys

Inside the `/team` overlay:

| Key | Action |
|---|---|
| `1` / `2` / `3` / `4` | Jump to Workers / Inspect / Console / Cost |
| `tab` / `shift+tab` | Cycle tabs |
| `↑` / `↓` (or `j` / `k`) | Move selection in the roster, or scroll the body of Inspect / Console / Cost. Manual scroll pauses follow in Inspect / Console |
| `enter` | Open the highlighted worker in Inspect (Workers tab) |
| `PgUp` / `PgDn`, `b` / `space`, `ctrl+u` / `ctrl+d` | Page up / page down. The plain-key aliases are Mac-friendly when Page keys are unavailable |
| `g` / `G` | Top / bottom. In Inspect / Console, `G` also enables follow at the tail |
| `f` | Toggle follow mode in Inspect / Console |
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

Inspect renders status, task, operator-needs, summary, the worker's `<final_answer>` block, and the latest assistant text in a single scrollable view. It uses readable section dividers so final answers and latest assistant text do not run together. The text formatter keeps common report shapes recognizable — Markdown-style headings and tables, list markers, separators, indented/code-like lines, and stack-trace-like lines — while wrapping instead of ellipsizing normal body content.

Console streams a bounded ring buffer of assistant text deltas (timestamped) per worker, then the existing console event timeline (status transitions, tool starts and ends, queue updates, errors, exit) under an `— events —` divider. When both streams are present, the assistant group appears first under `— assistant —`; routine event metadata is dimmed, while errors and recovery/queue events are highlighted. Console content is isolated per selected worker.

Inspect and Console both show a compact follow/paused header: `[follow]  scroll start-end / total` or `[paused f/G]  scroll start-end / total`. Press `f` to toggle tail-following, `G` to jump to the tail and follow, or scroll/page/top-jump to pause. Cost remains focused on worker usage/cost and shows a `Σ` aggregate row plus per-worker turns / in / out / cost. The aggregate row includes active workers plus retained totals from pruned terminal workers; per-worker rows remain currently tracked workers only.

## Inspect a worker's result

```text
/team-result <worker-id>
```

Prints the compact result surface that the orchestrator sees through `agent_result`: worker identity/status, task, compact summary sections, pending relays, usage/context, and the verbatim contents of the worker's `<final_answer>` block. Output uses friendly scan labels such as `Worker`, `Status`, `Headline`, `Read files (readFiles/files_read)`, `Changed files (changedFiles/files_changed)`, `Risks`, `Next`, and `Usage` so operators do not need to memorize raw tool schema keys. `/team-result` may also append a live `--- Latest assistant text ---` section for operator inspection; `agent_result` does not include that transcript tail and remains the authoritative synthesis surface. When Pi reports context budget, usage includes a compact marker such as `ctx=64%/200k rem=72k`.

Normal result shape:

```text
Worker: w1 (fixer)
Status: completed (Completed)
Task: Render result
Headline: Renderer improved
Read files (readFiles/files_read): src/ui/tool-formatters.ts
Changed files (changedFiles/files_changed): tests/ui/tool-formatters.test.ts
Risks: none
Next: reviewer to spot-check output
Usage: turns=1 input=1200 output=3400 cost=$0.0123

--- Final answer (from worker's <final_answer> block) ---
headline: renderer improved
verification: npm test passed
```

If the final answer is very short, the result includes a warning before the verbatim block:

```text
Final answer note: very short final_answer (1 word); verify it is sufficient before synthesizing.
--- Final answer (from worker's <final_answer> block) ---
done
```

If no `<final_answer>` block was extracted, the result says so and gives the corrective prompt:

```text
--- Final answer (from worker's <final_answer> block) ---
No <final_answer> block extracted yet. This agent_result has no authoritative deliverable; steer/re-delegate with: `Please wrap your final deliverable in <final_answer>…</final_answer> tags.`
```

When the block is missing, do not synthesize from transcript tail alone. Re-delegate, steer the worker with the corrective message, or stop and respawn with a clearer brief.

## Clean up finished workers

Press `p` inside the `/team` overlay to prune every terminal worker (`idle`, `completed`, `aborted`, `error`, `exited`) from the dashboard. Prune removes the worker rows/details and task registry entries, but folds each removed worker's token/cost usage into retained aggregate totals first. Useful after a cancelled batch when you want to start fresh without old rows cluttering the widget while preserving team statistics. Non-terminal workers are left alone, so pruning is safe while new workers are still active.

To clear every worker row: `/team-stop all` to stop every live worker, then `p` in the overlay to remove the terminal rows. Team token/cost totals survive on purpose. Each pruned worker's usage is folded into a retained aggregate so the Cost tab and footer `Σ` keep matching what the team actually spent; the Cost tab also prints a `retained/pruned` note so the aggregate is not confused with the visible per-worker rows. No command zeroes the retained totals; restart the Pi session for a fresh ledger.

## See aggregate token usage and cost

Open `/team` and press `4` (or cycle to the **Cost** tab) to see one row per currently tracked worker (turns, input/output tokens, cost) plus a `Σ` aggregate row. The `Σ` row includes active workers and retained usage from workers that were later pruned; when retained usage exists, the Cost tab adds a concise `retained/pruned` note so the aggregate is not confused with the visible per-worker rows. The orchestrator's own token usage stays in Pi's footer bar (`↑ input ↓ output $cost`), so the Cost tab focuses on the agent team.

Large token counts are abbreviated to keep the overlay and footer readable: `k` means thousands (1,000), and `m` means millions (1,000,000). For example, `in=143.5k` is about 143,500 input tokens and `out=1.3m` is about 1,300,000 output tokens.

The footer widget also shows a compact `Σ turns=… in=… out=… cost=$…` line as soon as any active or retained-pruned worker usage is non-zero, so you don't have to open the overlay for the running total. If all workers have been pruned but retained usage exists, the widget can still show the aggregate `Σ` line without per-worker rows.

To hide the `Σ` row, retained-pruned usage note, and Cost tab, set `display.cost: false` in your `agents-team.json`:

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

The orchestrator's `agent_message` tool takes `delivery: "auto" | "steer" | "follow_up"` and follows the same rules. Its tool result names the user-visible action: `Steering running agent fixer (w1).`, `Queued follow-up for fixer (w1).`, `Waking idle agent fixer (w1).`, or `Resuming agent fixer (w1).`

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

`agent_status` reports `reusable: true` on workers in `idle` or `waiting_followup`. Anything else has either no live session (`completed`/`aborted`/`error`/`exited`) or work in flight (`running`/`starting`); reuse fails fast with a per-status hint. Active pings and status/result views include `ctx=<percent>/<window> rem=<tokens>` when Pi reports context budget.

Context policy: reuse same-scope work normally below 50% context, cautiously from 50-70%, and prefer a fresh worker above 70%. Reuse is rejected at or above 80% context or when remaining context is at most 32768 tokens. Unknown context does not hard-reject reuse, but the orchestrator prompt tells agents to prefer fresh workers for long, exploratory, or multi-lane work. Do not stack more lanes onto a saturated worker; fan out independent lanes as fresh workers.

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

### Orchestrator tool output examples

Operators normally see these through model narration, logs, or `/team-result`; they are included here so runbooks can match the real tool text.

Fresh delegation returns launch metadata and the next wait call:

```text
Created fixer (w1)
Task: Build seam (t1)
Next: wait_for_agents workerIds=["w1"]
```

When the orchestrator intentionally reuses an idle same-scope worker, the first line makes that explicit:

```text
Reusing fixer (w1)
Task: Follow-up fix (t2)
Next: wait_for_agents workerIds=["w1"]
```

`wait_for_agents` uses compact user-facing outcomes without exposing internal reason labels. Common outcomes:

```text
Done: 2 agent(s) finished or stopped.
Next: read results with agent_result.

Workers:
- w1 (fixer) · status=completed (Completed) · task=Done task
- w2 (reviewer) · status=idle (Idle)
```

```text
Needs reply: 1 relay question(s).

Pending relay questions:
1. fixer (w1) [high]
   Need scope?
Next: answer with agent_message, then wait again for ["w1"].

Workers:
- w1 (fixer) · status=running (Running) · task=Question task
```

```text
Still waiting: some agents are still running.
Next: wait again or inspect status.
```

```text
Wait cancelled: stopped before all agents finished.
Next: inspect status or cancel unwanted agents.
```

```text
No agents to wait for.
Next: delegate a task first.
```

For `relay_raised`, answer each relay with `agent_message`, then immediately call `wait_for_agents` again with the same worker ids. For `timeout`, either wait again or inspect status before taking action; a timeout does not cancel workers. For `aborted`, decide whether to continue supervising, call `agent_status`, or cancel unwanted workers. For `no_workers`, delegate first — repeated waits cannot create work.

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

- `schemaVersion` doesn't match the current schema. The active layer falls back to built-ins and you get a toast pointing at `/team-init --force`. See [`profiles.md`](profiles.md) "Version bumps."
- The active config's `scaffoldVersion` is stale, or a current-schema active config is missing `scaffoldVersion`. This is a freshness nudge only: the active file keeps loading. Run `/team-init <local|global> --force` for the active scope when you want to refresh the scaffold; the previous file is backed up first.
- A prompt string that doesn't resolve to a file. It gets treated as inline prompt text, which is usually what you want. If you actually meant a path, fix the typo.
- A role has an invalid `thinkingLevel`. The extension drops only that field, keeps the rest of the role, and emits a toast such as `invalid thinkingLevel ... field dropped`. Fix the value to one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, then reload.

See [`profiles.md`](profiles.md) for the full role shape and prompt-resolution rules.

### A worker says thinking was clamped

Expected when a role requests a thinking level that the selected model does not support. Pi starts the worker anyway and reports the effective level through RPC; the extension shows a toast such as `requested thinkingLevel high; Pi clamped to low`.

To fix it, either set that role's `thinkingLevel` to a supported value or pick a model family that supports the requested level. `xhigh` is especially model-dependent.

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch.

### A worker is restored after reload but not actually running

Expected. Persisted workers are force-marked `exited` on restore so the operator sees what existed before the reload without being misled about process liveness.

On a warm session start (`reload`, `resume`, `fork`, `new`), a one-line warning toast announces how many workers were flipped and the session-start reason. Example: `Workers exited — 3 workers restored from resume; relaunch if needed.` Cold `startup` shows the compact info toast `Team ready — orchestrator mode`. Each flipped worker's `error` field carries a reason-specific message (`session resumed…`, `session forked…`), which surfaces in `/team` detail view and copy payloads.

### `/team-steer` "seems queued but nothing happens"

Look at the confirmation line: if it says `Prompted w<id> (…:idle)`, the worker was re-prompted and will start streaming again on its next event tick. If it says `Queued follow-up for w<id> (…:running)`, the message is sitting behind the live stream and will run after the current turn. Only terminal workers (`exited`, `aborted`, `error`, `completed`) refuse messages outright. A bare `follow_up` RPC against an idle Pi session only queues without waking it — the router upgrades that case to a full prompt automatically, so you don't need `--queue` for idle workers.

### A write-capable worker is rejected

Launch policy is doing its job. `fixer` requires an explicit writable `pathScope`. Either provide one on the delegated task or switch to a read-only profile like `explorer`, `reviewer`, or `oracle`.

### Routing toggle fails with "enable first"

`/team-enable on` requires `enabled: true` in `agents-team.json`. If delegation is turned off, edit the file manually to set `enabled: true` and run `/reload`. Routing toggles only take effect when delegation itself is on.

### `agent_result` returns an empty `<final_answer>`

The worker finished but did not follow the contract. Three moves, in order of preference: re-delegate with smaller slices, steer the existing worker with `/team-steer <id> <corrective message>` asking it to re-issue the final answer, or stop and re-spawn with a better brief. Do not fall back to running `bash`/`read`/`grep` yourself.

### "Worker complete" toast fired, but the worker is still running

Fixed. The `starting → idle` race has a guard in `applyNormalizedEvent` (worker stays `starting` until actually prompted) plus a filter in the batched worker notification flush that drops entries whose status has flipped back off-terminal by flush time. Terminal toasts use user-facing actions (`complete`, `failed`, `cancelled`, `exited`) while preserving internal statuses in `/team` and tool results. If you see this again, it is a real bug: check `src/runtime/worker-manager.ts` and the `onStateChange` listener in the internal implementation entrypoint (`extensions/pi-agent-team/index.ts`).

## Local verification commands

```bash
npm run typecheck
npm test
pi -e ./extensions/index.ts -p "/team"
```

That smoke command exercises the shipped package entrypoint in the same mode operators use: an overlay-style, keyboard-first panel in TUI environments, with a compact text fallback when no UI is available.
