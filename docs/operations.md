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
pi -e ./extensions/pi-agent-team/index.ts
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

- `/team` opens the interactive dashboard overlay in TUI mode, or prints the dashboard text in print mode.
- `/team <worker-id>` skips the list and opens the overlay directly on that worker's detail view (tab completion suggests live worker ids).

Opening the overlay triggers an active RPC refresh so token counts and streaming status are current. Press `r` inside the overlay to re-ping.

The always-visible footer widget already shows glyphs + counts (`▶ 3 running  ✓ 1 done  ○ 2 idle  ? 1 relay`) so there is no separate "status" slash command. Use `/team` when you need the full view.

### Dashboard keys

Inside the `/team` overlay:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection in the worker list |
| `enter` | Open the selected worker in detail view |
| `s` / `c` | Switch between Summary and Console tabs |
| `j`/`k` or `↑`/`↓` | Scroll detail view |
| `PgUp` / `PgDn` | Page scroll |
| `g` / `G` | Jump to top / bottom |
| `r` | Re-ping workers (fresh RPC state + stats) and refresh snapshot |
| `y` | Copy the current worker's task, summary, final answer, transcript, and console to the clipboard (in the list view, copies the highlighted worker) |
| `esc` | Back to list (or close from list) |
| `q` | Close overlay |

The keybinding help line is pinned right under the tabs, so it stays visible even if the body scrolls or the terminal clips the overlay. A transient `» …` line shows copy/refresh status for a few seconds.

The Console tab shows a bounded ring buffer of status transitions, tool starts and ends, assistant-text flushes, queue updates, errors, and exit reasons. Use it when a summary is not enough.

## Inspect a worker's result

```text
/agent-result <worker-id>
```

Prints the compact summary (headline, files read/changed, risks, next recommendation, pending relays, usage) plus the verbatim contents of the worker's `<final_answer>` block. This is the authoritative deliverable. If the block is empty, the worker did not follow the contract: re-delegate, steer it with a corrective message, or cancel.

## Clean up finished workers

```text
/team-prune
```

Removes every terminal worker (`idle`, `completed`, `aborted`, `error`, `exited`) from the dashboard. Useful after a cancelled batch when you want to start fresh without the old rows cluttering the widget and `/team` overlay. Non-terminal workers are left alone, so this is safe to run while new workers are still active.

If you want a hard reset, run `/agent-cancel all` first, then `/team-prune`.

## See aggregate token usage and cost

```text
/team-cost
```

Prints one line per tracked worker (turns, input/output tokens, cache reads/writes, cost) plus a `Σ` total row. The orchestrator's own token usage stays in Pi's footer bar (`↑ input ↓ output $cost`), so `/team-cost` focuses on the agent team.

The footer widget also shows a compact `Σ turns=… in=… out=… cost=$…` line as soon as any worker has non-zero usage, so you don't have to run the command to see the running total.

## Copy a worker's output to the clipboard

```text
/team-copy <worker-id>
```

Copies a single blob containing the worker's task, compact summary, pending relays, usage, final answer, latest assistant text, and the console timeline (status transitions, tool starts/ends, queue updates, errors, exit). Useful for pasting into an issue or sharing the full worker trace. Inside the `/team` overlay, `y` does the same for the currently focused worker.

Clipboard providers are picked by platform: `pbcopy` on macOS, `clip.exe` on Windows, and `wl-copy` / `xclip` / `xsel` on Linux (first one that works wins). If none are installed, the command prints the failure reason.

## Steer or queue follow-up work

```text
/agent-steer <worker-id> narrow to src/runtime only
/agent-steer all remember: the user cares about power, not just perf
/agent-followup <worker-id> after that, summarize the remaining risks
/agent-followup all when you finish, include a risks section
```

`/agent-steer` auto-routes per worker: steer if the target is `running`, follow-up if the target is `idle` or `waiting_followup`. It prints the mode used per worker so you can see where the message actually landed. Use `all` to broadcast to every deliverable worker at once.

`/agent-followup` always queues as follow-up. Use it when the next instruction should wait its turn.

If you see "it didn't seem to go through" on a single-worker send, double-check the printed confirmation line: it names the delivery mode (`Steered w1 (reviewer:running)` vs `Queued follow-up for w1 (reviewer:idle)`). A terminal worker (`exited`, `aborted`, `error`, `completed`) cannot receive messages and is skipped.

The orchestrator's `agent_message` tool exposes the same `delivery: "auto" | "steer" | "follow_up"` routing.

## Cancel a worker

```text
/agent-cancel <worker-id>
/agent-cancel all
```

Aborts the RPC session and shuts down the worker process. The compact state is marked `exited`; persisted state survives. `all` cancels every non-terminal worker in one call and prints a per-worker summary.

## Delegation notes

The orchestrator-facing tool is `delegate_task`. In normal use you do not type the tool call yourself: ask the orchestrator for the work and it decides when to delegate.

If a profile can write files (today, only `fixer`), provide an explicit writable path scope. Launch policy rejects write-capable tasks without one.

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

### A worker fails immediately with an API-key error

The worker inherits your Pi auth setup. Fix the missing provider key first, then relaunch.

### A worker is restored after reload but not actually running

Expected. Persisted workers are force-marked `exited` on restore so the operator sees what existed before the reload without being misled about process liveness. Relaunch if you still need that work.

### Steer does nothing

Steer only applies to running workers. If the worker is idle, use `/agent-followup` instead. The orchestrator's `agent_message` with `delivery: "auto"` picks the right mode for you.

### A write-capable worker is rejected

Launch policy is doing its job. `fixer` requires an explicit writable `pathScope`. Either provide one on the delegated task or switch to a read-only profile like `explorer`, `reviewer`, or `oracle`.

### `agent_result` returns an empty `<final_answer>`

The worker finished but did not follow the contract. Three moves, in order of preference: re-delegate with smaller slices, steer the existing worker with a corrective message asking it to re-issue the final answer, or cancel and re-spawn with a better brief. Do not fall back to running `bash`/`read`/`grep` yourself.

### "Worker finished" toast fired, but the worker is still running

Fixed. The `starting → idle` race has a guard in `applyNormalizedEvent` (worker stays `starting` until actually prompted) plus a filter in `flushTerminalNotifications` that drops entries whose status has flipped back off-terminal by flush time. If you see this again, it is a real bug: check `src/runtime/worker-manager.ts` and the `onStateChange` listener in `extensions/pi-agent-team/index.ts`.

## Local verification commands

```bash
npm run typecheck
npm test
pi -e ./extensions/pi-agent-team/index.ts -p "/team"
```
