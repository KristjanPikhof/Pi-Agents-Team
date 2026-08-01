# Operations guide

## Quick start

Requires Node `>=22.19.0`. Development validation uses exactly Pi `0.80.10`. The supported host and worker minimum remains Pi `0.80.6`. Use npm and `package-lock.json` as the authoritative dependency and lock workflow.

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

Load the source shim for a local-development check:

```bash
pi -e ./extensions/index.ts
```

This command does not validate the compiled or published package entrypoint. Run the focused package checks for that contract:

```bash
npm run build
npx tsx --test tests/package-manifest.test.ts tests/package-publish.test.ts
```

**Large-session warning:** This release does not repair existing multi-gigabyte legacy sessions. They may be unsafe to resume. Start a genuinely new session instead, or migrate the JSONL offline while Pi is stopped.

Run one test file:

```bash
tsx --test tests/runtime/worker-manager.test.ts
```

## Manage persisted session growth

Pi Agents Team stores compact v2 `worker_terminal` revisions and `worker_pruned` transitions in Pi's append-only JSONL session. Routine running-state churn and timestamp-only refreshes do not write. Terminal status, substantive terminal summary or usage revisions, and prune transitions do write. Each compact record is capped at 16 KiB of serialized UTF-8; trimming keeps Unicode code points intact.

Prune controls the dashboard, not the physical file. Reload, prune, tree navigation, and fork do not remove JSONL entries or reclaim disk space. If you need to reclaim space:

1. Prefer starting a genuinely new Pi session.
2. If the old history must be retained, stop Pi and use an offline migration that writes a new session file. Keep a backup and do not edit the active JSONL in place.
3. Do not resume an existing multi-gigabyte legacy session expecting this extension to compact or repair it.

Persisted sessions warn inclusively when the active branch reaches either 10,000 recognized compact records or 64 MiB of recognized compact payload bytes. The byte count covers JSON payloads only. It excludes Pi's JSONL framing, legacy v1 entries, malformed or future-version entries, inactive branches, other entry types, and the total session file size. A warning is deduplicated while the branch stays above a threshold and rearms after measurement drops below both thresholds, such as after switching to a smaller branch. Ephemeral sessions suppress this physical-growth warning.

Writes follow `prepare → synchronous append → commit`. Append failures keep the failed record and untouched suffix for retry, while the latest observed terminal summary and usage remain available for a later prune. Each flush is limited to two batches: the retained suffix, then one batch derived from the latest state. Shutdown disposes workers while the persistence listener is still attached, then performs a final bounded flush. If data is still unsaved, look for this warning:

```text
Pi Agents Team: a compact persistence append still failed during final retry; the uncommitted transition could not be saved before teardown.
```

Tree navigation retries pending data on the origin branch before moving. Cancelled or aborted navigation leaves that data retryable there. Once navigation is confirmed, unresolved old-branch records are discarded rather than written to the new branch, and the extension warns that they were isolated.

Restore replays recognized records from the active branch only. Compact records are deduplicated by record ID; malformed and future-version entries are ignored. Legacy v1 snapshots remain readable, but only their compact allowlisted fields are recovered. Restored live or reusable workers are marked `exited` because no RPC process is attached; their compact summary and authoritative usage remain.

## Inspect the team

```text
/team
/team <worker-id>
```

In TUI sessions with Pi's autocomplete provider API, the editor also understands natural team references:

| Trigger | Suggests | Example |
|---|---|---|
| `@` | tracked workers by id, role, status, or task title | `@w1` |
| `$` | configured worker roles | `$reviewer` |

Suggestions appear at the start of a token after whitespace. File completion is suppressed inside those `@` / `$` tokens so paths and team references do not fight each other.

- `/team` opens the interactive dashboard overlay in TUI mode, or prints a compact refreshed dashboard summary in RPC/non-TUI mode. Treat it as the full live worker registry: running, queued, idle/reusable, recent terminal, error, and retained-cost state are all reachable there rather than through separate status commands.
- Top tabs (`1` Workers · `2` Inspect · `3` Console · `4` Cost) are jumped with the number row, or `tab` / `shift+tab` to cycle. The overlay is a single right-anchored stack panel; switch to `Workers` to change selection, then use `Inspect` or `Console` for the selected worker.
- `/team <worker-id>` skips the roster and opens the overlay on that worker's Inspect tab in TUI mode (tab completion suggests live worker ids). RPC/non-TUI mode stays summary-only; use `/team-result <worker-id>` for the authoritative final deliverable.

Opening the overlay triggers an active RPC refresh so token counts and streaming status are current. Press `r` outside the Console tab to re-ping. In Console, `r` toggles between the default Activity view and the Raw/debug view. Refreshing does not reset recent terminal-row retention: old terminal rows continue to age out by time unless you prune them.

While the initial refresh is in flight, the overlay shows a compact loading spinner. If a worker refresh times out, `/team` shows the latest registry snapshot instead of hanging and marks the worker with an active-ping timeout warning. The overlay is theme-aware and uses the Pi host's active `Theme` for colors, borders, and status accents.

The always-visible footer widget already shows glyphs + counts (`▶ 3 running  ✓ 1 done  ○ 2 idle  ? 1 relay`) plus an inline `Σ` cost column when active or retained-pruned usage is non-zero — there is no separate "status" slash command. Active rows display task elapsed time (using the current task start on reused workers); recent terminal rows are retained for five minutes so finishes remain visible briefly after completion, or until the operator prunes them. Command tips rotate in the bottom orchestrator status line, for example `Orchestrator · Idle · Tip: Use /team to view workers`. The line switches to `Working...` while the visible orchestrator turn is active, and also while worker/relay activity is active.

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
| `r` | Re-ping workers outside Console; inside Console, toggle Activity / Raw |
| `y` | Copy the selected worker's task, summary, final answer, Activity, and Raw console diagnostics to the clipboard |
| `q` / `esc` | Close overlay (`esc` also cancels a modal) |

The header carries a tab bar, the per-tab help row, and the selected worker's priority snippet. When routing is off, the bar shows a `solo` badge; idle workers carry a `[reuse]` tag in the roster row and `[reusable]` in the Inspect header so reusable sessions are obvious. A transient `» …` status line surfaces last action / refresh / error feedback for a few seconds.

Inspect renders status, a compact `Recent activity` section, task, operator-needs, summary, the worker's `<final_answer>` block, and the latest assistant text in a single scrollable view. `Recent activity` stays intentionally short: it lists recent commands, process notes, and final-answer production without copying dense task prompts or raw transcript text. Worker-controlled text is made terminal-safe before it reaches Inspect, Console, or copy payloads: OSC/DCS/CSI/ESC control sequences and non-printable controls are stripped, tabs become spaces, and Pi-owned theme colors are applied only after sanitization. The text formatter keeps common report shapes recognizable — Markdown-style headings and tables, list markers, separators, indented/code-like lines, and stack-trace-like lines — while wrapping instead of ellipsizing normal body content.

Console opens on the human-readable `— activity —` view. Activity items are Pi-themed blocks: commands and tools get a framed header, readable status (`[running]`, `[ok]`, `[error]`, or `[info]`), a `$` command line, nested output, and footer metadata such as duration plus the `raw:r` escape hatch. Tool status, command headers, and diff-style output use the active Pi theme roles (accent, success, danger, warning, muted) rather than hardcoded colors. Git-like output keeps its textual `+` / `-` / `±` markers so the meaning survives plain text copies, while additions/deletions are also colored in the TUI. Long output is elided with an explicit hidden-line count such as `… +14 lines hidden`. Process notes are short operational summaries, not private reasoning dumps. Final answers render the parsed `Headline`, `Risks`, and `Next` fields when present instead of dumping the entire block into the Activity card; the full verbatim block remains available in Inspect, `/team-result`, and copy payloads. Press `r` in Console to switch to `— raw —`; press `r` again to return to Activity. Raw/debug keeps timestamped assistant chunks and console events for diagnostics, including status transitions, tool starts and ends, queue updates, errors, and exit. Activity, assistant chunks, and Raw diagnostics are bounded in memory only; raw transcripts/events are not persisted and are not a synthesis fallback. Console content is isolated per selected worker.

Example Console Activity output (the docs show plain text; in the TUI, `[ok]`, command headers, and `+` / `-` diff markers use theme colors):

```text
— activity —
╭─ process thinking [info] 00:13:20 ─
│ Mapping current console rendering before proposing UI changes.
╰─ raw:r

╭─ tool command [ok] 00:13:21 ─
│ $ git diff --stat main...HEAD
│ src/ui/overlay.ts              | 42 +++++++++++++++++
│ tests/ui/overlay.test.ts       | 18 +++++++
│ ± 2 files changed, +60 insertions, -0 deletions
│ … +14 lines hidden
╰─ took 1.0s · raw:r

╭─ final-answer [ok] 00:13:24 ─
│ Headline: APPROVE — no blocking issues found.
│ Risks: UI wrapping tests need updates.
│ Next: Safe to continue after typecheck.
╰─ raw:r
```

Example Inspect `Recent activity` output:

```text
Recent activity
• Ran grep "buildConsoleLines" src/ui/overlay.ts
• Ran npm run typecheck
• Thinking: comparing overlay width behavior
• Final answer produced
```

Inspect and Console both show a compact follow/paused header: `[follow]  scroll start-end / total` or `[paused f/G]  scroll start-end / total`. Press `f` to toggle tail-following, `G` to jump to the tail and follow, or scroll/page/top-jump to pause. Cost remains focused on worker usage/cost and shows a `Σ` aggregate row plus per-worker turns / in / out / cache / cost when cache counters are non-zero. The aggregate row includes active workers plus retained totals from pruned terminal workers; per-worker rows remain currently tracked workers only.

## Inspect a worker's result

```text
/team-result <worker-id>
```

Prints the command result surface for a worker: a plain-text worker title, optional task/status/error, pending relay questions, and `Result:` followed by the verbatim contents of the worker's `<final_answer>` block. `/team-result` may include latest assistant text only when no final answer exists; `agent_result` remains the transcript-free synthesis surface and may additionally include scan-friendly summary sections such as `Headline`, `Read files`, `Changed files`, `Risks`, and `Next` when available.

Normal result shape:

```text
fixer (w1)
Task: Render result

Result:
headline: renderer improved
verification: npm test passed
```

Pending relays are shown before the result:

```text
fixer (w1)
Task: Decide scope
Status: waiting_followup (Waiting for follow-up)

Pending relay questions:
- [high] Retry with smaller scope?
  assumption: Yes

Result:
done
```

If no `<final_answer>` block was extracted, the result says so:

```text
fixer (w1)

Result:
No final answer block extracted yet.
```

When the block is missing, do not synthesize from transcript tail alone. Re-delegate, steer the worker to wrap its final deliverable in `<final_answer>…</final_answer>`, or stop and respawn with a clearer brief.

## Clean up finished workers

Press `p` inside the `/team` overlay to prune every terminal worker (`idle`, `completed`, `aborted`, `error`, `exited`) from the dashboard. Prune removes the worker rows/details and task registry entries, but folds each removed worker's token/cost usage into retained aggregate totals first. It also appends a compact prune transition. It does not delete earlier JSONL records or shrink the session file. Use it after a cancelled batch when you want to remove old rows while preserving team statistics. Non-terminal workers are left alone, so pruning is safe while new workers are still active.

To clear every worker row: `/team-stop all` to stop every live worker, then `p` in the overlay to remove the terminal rows. Team token/cost totals survive on purpose. Each pruned worker's usage is folded into a retained aggregate so the Cost tab and footer `Σ` keep matching what the team actually spent; the Cost tab also prints a `retained/pruned` note so the aggregate is not confused with the visible per-worker rows. No command zeroes the retained totals; restart the Pi session for a fresh ledger.

## See aggregate token usage and cost

Open `/team` and press `4` (or cycle to the **Cost** tab) to see one row per currently tracked worker (turns, input/output tokens, cost) plus a `Σ` aggregate row. Worker cost is the value Pi reports through RPC, including Pi's model/provider tier and long-context pricing. Pi Agents Team does not recompute cost from token counters; it retains, sums, and formats Pi-reported worker values. The `Σ` row includes active workers and retained usage from workers that were later pruned; when retained usage exists, the Cost tab adds a concise `retained/pruned` note so the aggregate is not confused with the visible per-worker rows. The orchestrator's own token usage stays in Pi's footer bar (`↑ input ↓ output $cost`), so the Cost tab focuses on the agent team.

Large token counts are abbreviated to keep the overlay and footer readable: `k` means thousands (1,000), and `m` means millions (1,000,000). For example, `in=143.5k` is about 143,500 input tokens and `out=1.3m` is about 1,300,000 output tokens.

When Pi reports cache tokens, non-zero cache counters appear as `cache=r<read>/w<write>` in the Cost tab, copy payloads, and the footer `Σ` line when it fits. In the footer, enough horizontal space adds `hit=<percent>` after the cache counters, for example `cache=r16.6m/w0 hit=98.0%`. This is the cumulative team cache hit rate, computed as `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`. Narrow footers drop `hit=` before dropping the cache field. Workers with no cache activity omit the cache field so narrow displays stay clean.

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

Copies a single Markdown blob containing the worker's task, compact summary, pending relays, usage, final answer, latest assistant text, `## Activity`, and `## Console timeline (Raw)`. `## Activity` appears before the Raw section so pasted logs are readable first while still carrying timestamped diagnostics for support. The latest assistant text is sanitized and capped to the retained tail (4,000 lines and 256 KiB); if older content is omitted, the section starts with `[transcript truncated: showing retained tail; omitted …]`. If no activity was captured, the payload says `(no activity captured)`; if Raw diagnostics exist, they stay under `## Console timeline (Raw)`. Inside the `/team` overlay, `y` does the same for the currently focused worker.

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

- **Running / starting** workers: cancels — aborts the RPC session and shuts down the process. State is marked `exited`; a compact summary and authoritative usage can survive, but the final answer is live-session-only.
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

`/team-enable on` and `/team-enable off` flip orchestrator behavior live. No `/reload` needed. With no persistence flag, the change is session-only and resets on `/reload` or restart; pass `--local` or `--global` when you want the choice to stick.

```text
/team-enable off                       # solo for this session only
/team-enable off --local               # persist to ./.pi/agent/agents-team.json
/team-enable on                        # back to team for this session only
/team-enable on --global               # persist to ~/.pi/agent/agents-team.json
/team-enable off --persist local       # deprecated alias for --local
```

What changes in **solo** mode:

- `delegate_task` rejects with `Team routing off. Run /team-enable on to delegate.`. The orchestrator prompt drops the profile catalog and gets a one-line directive telling it to answer directly.
- The widget collapses to a single `Pi Agents Team — solo` line when workers are tracked, or hides entirely when none are. The bottom status line also shows solo routing explicitly, e.g. `Orchestrator · Solo · Working...` or `Orchestrator · Solo · Idle`, plus the current rotating tip.
- `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, and `agent_cancel` stay live so workers spawned earlier can still be inspected, steered, or shut down.

Persistence is explicit:

- No flag: update only the live in-memory routing mode and print a session-only reset reminder.
- `--local`: write `routingMode` to `<cwd>/.pi/agent/agents-team.json`.
- `--global`: write `routingMode` to `~/.pi/agent/agents-team.json` (or `PI_AGENT_TEAM_GLOBAL_CONFIG_PATH`). If a project-local config exists, the command warns that the local file shadows the global value in this project.
- `--persist local|global`: deprecated alias retained for compatibility; docs and completions prefer `--local` / `--global`.

Use explicit persistence when you want the next session to boot with the same routing mode. A persisted global default applies only in projects that do not have their own local `agents-team.json`.

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

Workers launched inside the trusted project root inherit the orchestrator's current Project Trust decision as an explicit Pi CLI override: trusted projects launch with `--approve`, untrusted projects launch with `--no-approve`, and unrelated worker cwd values receive no override. Reuse treats this as a launch setting; a worker spawned with one trust mode cannot be reused for a task that would require the other.

By default, delegated path scopes may include `/tmp`, sibling repos, or other absolute paths. If you need to restrict delegated worker scopes to the discovered project root / current cwd, opt out via `agents-team.json`:

```json
"workerAccess": {
  "allowPathsOutsideProject": false
}
```

That only restricts delegated worker path-scope containment. The main orchestrator session and worker prompt-file containment are unchanged; prompt files must remain inside the project/current cwd.

The orchestrator should pair every `delegate_task` with a `wait_for_agents` call, then `agent_result` per worker, and synthesize a single answer. It should not loop `ping_agents`, should not sleep in bash, and should not run investigation tools itself while workers are active. Pi's `agent_end` event is only a model-loop boundary. Successful idle, wait completion, result readiness, and reuse occur at `agent_settled`; waits therefore stay active between those events. Worker-complete and relay toasts are UI-only hints; the tool loop is the authority. See [`../prompts/orchestrator.md`](../prompts/orchestrator.md).

### Orchestrator tool output examples

Operators normally see these through model narration, logs, or `/team-result`; they are included here so runbooks can match the real tool text.

Fresh delegation uses the tool-call title for the action (`Launching fixer agent`) and keeps the receipt to one compact worker/task line:

```text
w1 · Build seam (t1)
```

When the orchestrator intentionally reuses an idle same-scope worker, the tool-call title can include the known worker id (`Reusing fixer agent (w1)`), and the receipt stays the same shape:

```text
w1 · Follow-up fix (t2)
```

`wait_for_agents` is the zero-token supervision loop. It returns a human-readable `Wait:` outcome plus a `Next:` instruction; follow that instruction instead of polling with `ping_agents` or sleeping in bash. Common outcomes:

```text
Wait: all agents finished
Status: 2 agent(s) finished or stopped
Next: read results for w1, w2.

Workers:
- w1 (fixer) · Completed · Done task
- w2 (reviewer) · Idle
```

```text
Wait: relay question raised
Status: 1 relay question(s) need reply

Pending relay questions:
1. fixer (w1) [high]
   question: Need scope?
   reply: send answer to w1
Next: answer relay(s), then wait for w1.

Workers:
- w1 (fixer) · Running · Question task · 1 relay
```

```text
Wait: timeout
Status: still waiting for active agent(s)
Next: wait again for w1 or inspect status.

Workers:
- w1 (fixer) · Running · Long task
```

```text
Wait: aborted
Status: wait cancelled before all agents finished
Next: inspect status or cancel unwanted agents.

Workers:
- w1 (fixer) · Running · Long task
```

```text
Wait: no agents
Status: no agents tracked
Next: delegate a task first.
```

For relay questions, answer each relay, then immediately call `wait_for_agents` again with the same worker ids. For timeouts, either wait again or inspect status before taking action; a timeout does not cancel workers. For aborted waits, decide whether to continue supervising, inspect status, or cancel unwanted workers. If there are no agents, delegate first — repeated waits cannot create work.

`agent_result` is the transcript-free synthesis surface for the orchestrator. It shows a compact worker header, pending relay questions, available scan-friendly summary sections, and `Result:` followed by the verbatim `<final_answer>` block. The parsed summary sections are limited to the supported contract fields (`Headline`, `Read files`, `Changed files`, `Risks`, and `Next`); Console Activity only renders parsed final-answer `Headline`, `Risks`, and `Next`. `/team-result` prints the related operator command surface with the same header/relay/result contract, but omits summary metadata sections and may include latest assistant text only when no final answer exists.

```text
fixer (w1)
Task: Build seam

Result:
headline: seam implemented
changed_files:
- src/runtime/seam.ts: added guarded adapter
verification:
- npm test → passed
risks:
- none known
```

If a worker is still waiting on the operator, pending relays appear before the result:

```text
fixer (w1)
Task: Decide scope
Status: waiting_followup (Waiting for follow-up)

Pending relay questions:
- [high] Retry with smaller scope?
  assumption: Yes

Result:
No final answer block extracted yet.
```

If the `<final_answer>` block is missing, do not synthesize from transcript tail or persisted state. Steer the worker to emit the required block, or re-delegate with a clearer brief.

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

### Project-local config is ignored in an untrusted project

Pi Agents Team does not read `<project>/.pi/agent/agents-team.json` until `ctx.isProjectTrusted()` says the project is trusted. This prevents an untrusted repo from changing worker roles, prompt paths, tool access, or path scopes before the operator approves it.

What you see:

- The session uses global config or built-in roles instead of the local file.
- Delegation still works if global/built-in config is otherwise active.
- After trusting the project, reload/restart the Pi session so the local config is read and frozen for the session.

### A worker is rejected before RPC launch

Before the first launch for a Pi command, the extension runs that command with `--version`. Pi versions older than `0.80.6`, missing version output, and unparseable version output are fatal because the worker RPC contract cannot be verified. Fix the selected Pi command or upgrade it, then delegate again.

A parseable worker version at or above `0.80.6` is supported even when it differs from the host Pi version. The extension emits one non-fatal mismatch warning per session and continues; exact patch equality is not required.

### Delegation is disabled because `agents-team.json` is invalid

Expected when the winning role config hits a hard error. Project-local files win by presence once the project is trusted: a local file that exists but is invalid does not fall back to global roles, because that could silently broaden a repo-specific role set. The extension warns on session start, adds a prompt note telling the orchestrator delegation is disabled, and rejects `delegate_task` until the file is fixed.

Common causes (hard errors):

- The JSON isn't parseable (syntax error).
- A path-shaped prompt string is missing or resolves to something other than a regular file.
- A prompt path escapes the project root.
- A `pathScope` root escapes the project root while `workerAccess.allowPathsOutsideProject` is explicitly `false`.
- A role declares `access.extensionMode: "inherit"` (recursion guard).
- A role combines `access.extensionMode: "disable"` with `access.extensions`.
- A role declares `access.extensions` that would load `pi-agents-team` itself.

Soft warnings don't disable delegation (the config keeps working):

- `schemaVersion` doesn't match the current schema. The active layer falls back to built-ins and you get a toast pointing at `/team-init --force`. See [`profiles.md`](profiles.md) "Version bumps."
- The active config's `scaffoldVersion` is stale, or a current-schema active config is missing `scaffoldVersion`. This is a freshness nudge only: the active file keeps loading. Run `/team-init <local|global> --force` for the active scope when you want to refresh the scaffold; the previous file is backed up first.
- A role has an invalid `thinkingLevel`. The extension drops only that field, keeps the rest of the role, and emits a toast such as `invalid thinkingLevel ... field dropped`. Fix the value to one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, then reload.

See [`profiles.md`](profiles.md) for the full role shape and prompt-resolution rules.

### A worker says thinking was clamped

Expected when a role requests a thinking level that the selected model does not support. Pi starts the worker anyway and reports the effective level through RPC; the extension shows a toast such as `requested thinkingLevel high; Pi clamped to low`.

To fix it, either set that role's `thinkingLevel` to a supported value or pick a model family that supports the requested level. `xhigh` and the opt-in `max` level are model/provider-dependent.

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch.

### Windows worker launch fails with `spawn pi ENOENT`

Current builds use `cross-spawn` for worker processes on Windows, so `pi --mode rpc --no-session` should resolve through the same command lookup behavior operators expect from a shell. If you still see `spawn pi ENOENT`, first confirm the Pi CLI is on `PATH` for the process that launched the orchestrator:

```bash
pi --version
```

Then restart the terminal or host app, reload Pi, and try delegation again. If the CLI command works in a separate shell but workers still fail, capture the worker error from `/team-result <id>` or `/team-copy <id>` and include the Windows shell/host app, Node version, and extension version; that is a launch bug rather than a role-config problem.

### A custom provider model is unavailable

Expected when the worker model is set to something like `myAnthropic/claude-opus-4-7` but the worker did not load the extension that registers `myAnthropic`. Provider/model extensions must run before Pi resolves the worker model, so put the provider source in that role's `access.extensions` and keep `access.extensionMode: "worker-minimal"`:

```json
"oracle": {
  "model": "myAnthropic/claude-opus-4-7",
  "access": {
    "extensionMode": "worker-minimal",
    "extensions": ["./extensions/myAnthropic-provider.ts"]
  }
}
```

The provider extension should call `pi.registerProvider("myAnthropic", ...)` during extension load. Worker-minimal still passes `--no-extensions`, then adds one Pi `--extension`/`-e` source for each `access.extensions` entry. Do not switch to `inherit`, and do not list `pi-agents-team` itself; both are blocked to prevent recursive orchestrators.

### A worker is restored after reload but not actually running

Expected. Restored workers that had a live or reusable status are marked `exited` so the operator sees their saved result without being misled about process liveness. Their compact summary and authoritative usage are retained. The prior task, relay, final answer, transcript, process ID, and raw runtime error are not restored.

On a warm session start (`reload`, `resume`, `fork`, `new`), a one-line warning toast announces how many workers were flipped and the session-start reason. Example: `Workers exited — 3 workers restored from resume; relaunch if needed.` Cold `startup` shows the compact info toast `Team ready — orchestrator mode`. The runtime adds a reason-specific live error (`session resumed…`, `session forked…`) for the detached worker; that error is not part of the persisted payload.

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

Check the source shim during development:

```bash
pi -e ./extensions/index.ts
```

Check the compiled Pi entrypoint:

```bash
npm run build
pi -e ./dist/extensions/index.js
```

Check the published package contract by packing, installing offline, and importing from a clean consumer:

```bash
npx tsx --test tests/package-manifest.test.ts tests/package-publish.test.ts
```

For a manual TUI overlay check, start either Pi entrypoint interactively and enter `/team` after Pi opens. Do not use `-p "/team"` as evidence for overlay behavior: `-p` submits a prompt and does not exercise interactive overlay input or rendering.
