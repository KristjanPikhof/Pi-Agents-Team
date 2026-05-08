# Agent

Load-bearing invariants and anti-patterns. Doc pointers at bottom; don't duplicate.

## What this repo is

Pi extension. Visible Pi session = orchestrator; bounded work runs in background workers via `pi --mode rpc --no-session`. Orchestrator keeps compact state (summary, relays, status, usage) plus each worker's `<final_answer>…</final_answer>`. Never full transcripts.

Non-negotiables: 1) one user-facing agent; 2) background workers only (RPC, not nested chat); 3) compact state over transcripts (raw assistant text only in-memory on `WorkerManager`).

## Dev commands

```
npm install
npm run typecheck       # tsc --noEmit
npm test                # tsx --test tests/**/*.test.ts (node:test + assert/strict)
npm run check           # typecheck + test
npm run smoke:runtime
npm run smoke:team
```

Single test: `tsx --test tests/runtime/worker-manager.test.ts`. Local load: `pi -e ./extensions/index.ts`.

## Architecture

`extensions/index.ts` (re-export) → `extensions/pi-agent-team/index.ts` (tools, commands, UI wiring) → `src/control-plane/team-manager.ts` (single coordination boundary) → `src/runtime/` (process + RPC + event normalizer + manager) → `src/comms/`, `src/profiles/`, `src/safety/`, `src/prompts/`, `src/ui/`, `src/commands/`. Commands wrap `TeamManager`; never touch `WorkerManager` directly. Topology: [`docs/architecture.md`](docs/architecture.md).

## Operator + tool surface

- 14 slash commands (incl. `/agent-result`). See [`README.md`](README.md), [`docs/operations.md`](docs/operations.md).
- 7 orchestrator tools: `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.
- Overlay (`/team`): top tabs `Workers / Inspect / Console / Cost` (`1`–`4`, tab cycle); persistent action bar `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit`; inline single-line modal for `s`/`m`/`n`; live-tail Console via `getAssistantTail` + `onAssistantChunk`; header solo badge from `routingMode`; `[reuse]` tag on idle/waiting_followup rows. Theme via `src/ui/theme.ts` (ANSI helpers + box-drawing frame chars).
- Removed, do NOT re-add without discussion: `/team-status`, `/agents`, `/ping-agents`.

## Load-bearing invariants

Terminal status set is canonical. `isTerminalWorkerStatus` = `idle | completed | aborted | error | exited`. `starting | running | waiting_followup` non-terminal. Gates `wait_for_agents`, terminal toasts, widget glyph, "all" broadcasts, UI "done" states. Keep `deriveStatusFromSessionState` and `applyNormalizedEvent` aligned.

`starting → idle` race guard. `WorkerManager.launchWorker` calls `refreshState` before `promptWorker`; `isStreaming: false` naively maps to `idle`. `worker_state` keeps `starting` while `isStreaming` is false; `flushTerminalNotifications` re-filters queued toasts vs current status. Guard scope: `status === "starting" && !event.state.isStreaming`. Widening breaks running→idle; narrowing brings back "worker finished" toasts.

Rejected prompt acceptance is terminal. `promptWorker` marks worker `running` before RPC `prompt` returns. If call rejects, catch, mark `error`, emit state change, rethrow. No ghost-running workers.

Terminal workers reject messages. `messageWorker` throws when `worker.status` ∈ `UNREACHABLE_STATUSES` (`completed | aborted | error | exited`). `idle` and `waiting_followup` stay alive — RPC accepts prompts.

Delivery resolution is a 3-way union. `AgentMessageResult.delivery` = `"steer" | "follow_up" | "prompt"`. `steer`/`follow_up` only while streaming; on idle/waiting_followup both `/agent-steer` and `/agent-followup` upgrade to `"prompt"` (fresh RPC wakes session). Dropping `"prompt"` reintroduces "queued but nothing happens" bug. Overlay `[s]teer`/`[m]sg` defer to this resolver — only block unreachable terminal pre-call; do NOT pre-block idle/waiting.

`wait_for_agents` wakes on relays. Resolves `all_terminal | relay_raised | timeout | aborted`. `relay_raised` carries `newRelays: {workerId, profileName, question, urgency}[]`. Baseline relay count snapshotted per call. Opt out: `wakeOnRelay: false`. See "Wait, don't poll" in [`docs/architecture.md`](docs/architecture.md).

Placeholder relay filter, 3 layers. Models drift and emit `relay_question: none | n/a | - | null`. (1) `extractRelayQuestions` filters via `PLACEHOLDER_RELAY_VALUES`; (2) relay-toast listener refuses empty/whitespace; (3) `buildWorkerTaskPrompt` tells models to omit. Remove any layer → "needs guidance: none" noise returns.

Summary file aliases are deliberate. `buildWorkerSummaryFromText` accepts `read_files`/`changed_files` AND `files_read`/`files_changed`. Drop either → file evidence hidden from `/team`, `agent_result`, copy payloads.

Assistant-chunk ring buffer is bounded, never persisted. Per-worker `assistantChunks` ring: `ASSISTANT_BUFFER_CHUNK_CAP = 4096` text-delta chunks (chunks not lines; one delta may contain `\n`s) + `ASSISTANT_BUFFER_BYTE_CAP = 256 KB`, monotonic per-task indexes. Byte cap bounds memory; chunk cap defends against many tiny deltas. `getAssistantTail(workerId, fromIndex?)` returns chunks ≥ fromIndex; `onAssistantChunk(listener)` lets Console live-tail without polling. Reuse resets (chunks=[], bytes=0, nextIndex=0). `config.persistence.storeTranscripts` stays `false`. Eviction must keep ≥1 chunk; else single oversized delta self-evicts and Console blanks.

Close vs cancel vs prune are distinct.

| Verb | Target | Effect | Final |
|---|---|---|---|
| `cancelWorker` | non-terminal | aborts stream, SIGTERMs process | `exited` (or `aborted` on race) |
| `closeWorker` | idle/waiting_followup | disposes RPC; sets `closing` so `worker_exit` lands as `exited` not `aborted` | `exited` |
| `pruneTerminalWorkers` | terminal entries | per entry: `WorkerManager.removeWorker` (closes leftover live handle for idle/waiting), unsubscribes RPC, drops registry entry. Async | (removed) |

No auto-prune on terminal transition: operators want batch history until `/team-prune`. Prune disposes idle handles to stop leaking processes.

Reuse is launch-strict. `delegate_task.reuseWorkerId` re-prompts existing idle/waiting_followup worker's RPC instead of spawning. Process-launch flags (`model`, `tools`, `cwd`, `systemPromptPath`, `extensionMode`, `thinkingLevel`, `allowSkills`) bake at spawn. `WorkerManager` snapshots on `launchWorker` (`record.launchSnapshot`); `TeamManager.reuseWorkerForTask` recomputes via `applyLaunchPolicy`, rejects per-field on mismatch. Cross-profile reuse rejected. Reuse resets per-task state (`textBuffer`, `finalAnswer`, `lastTool`, `relayQuestions`, `lastSummary`, `error`, `assistantChunks`) before re-prompting.

`closing` flag is load-bearing. `WorkerRuntimeRecord.closing` lets `closeWorker` distinguish operator disposal from crash. Without it, `worker_exit` from `handle.dispose()` maps `SIGTERM` → `aborted`. `closeWorker` sets `closing = true`, then disposes; `worker_exit` branch checks flag, forces `exited`. Don't reuse for other paths; cancel does NOT set it.

Widget spinner timer. 120 ms `setInterval` while `hasAnimatedWorkers(state)`. Starts on state change, stops when last non-terminal worker finishes, stops on `session_shutdown`, `.unref()`s. Touching cadence/animation? Stop the old timer first.

Visible-width + ANSI handling in TUI code. Widget + overlay use pi-tui `visibleWidth` / `truncateToWidth` (ANSI-aware: strip CSI before measuring). Never raw `.length` / `.slice`. Overlay `sanitizeText` normalizes `\t` → 4 spaces, strips control bytes EXCEPT `\x1b`. Widening strip regex to include `0x1b` silently strips theme.ts colors. Pi-tui validates rendered line widths vs terminal columns, crashes session if exceeded — that's why `\t` must be normalized (terminal expands tab to 8 cols though `visibleWidth` measures 1).

Overlay row budget must match `maxHeight`. `TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight = "90%"` paired with `OVERLAY_HEIGHT_PCT = 0.9`. `computeOverlayRows(termRows) = floor(termRows * OVERLAY_HEIGHT_PCT)`. Render > clipped rectangle → pi-tui truncates tail, bottom frame + footer disappear. Bumping one requires bumping the other + updating row-budget regression test in `tests/ui/overlay.test.ts`.

Console viewport reserves 1 row for `[follow]/[paused]` header. `renderConsoleBody` computes `visible = rows - 1`, uses for both `maxTop` and slice. Bare `rows` for `maxTop` while slicing `rows - 1` drops newest line at tail.

`/team` `[n]ew` mirrors `delegate_task` solo guard. Both modal-open AND submit-time check `teamManager.routingMode === "solo"`, refuse with `"Team routing off. Run /team-on to delegate."`. Submit-side guard catches operator toggling solo while modal is open; without it, `[n]ew` bypasses tool-side guard.

`[n]ew` always delegates fresh; never silently forwards `reuseWorkerId` from selected worker. Forwarding would reset that worker's `<final_answer>`/summary on submit. Reuse stays orchestrator-only via `delegate_task.reuseWorkerId`.

Overlay `dispose()` is exposed and idempotent. Component returns `{ render, invalidate, handleInput, dispose }`. `q`/`esc` paths call `dispose()` then `done()`. If pi-tui closes overlay outside our `done()`, host should call `dispose()` to unsubscribe `onAssistantChunk`; else listener leaks across open/close cycles.

Session restore is honest. `markRestoredWorkersExited` flips every restored worker to `exited` on session start. Handler threads `SessionStartEvent.reason` through error string, emits one warning toast when `reason !== "startup"` and ≥1 worker flipped. Never silently reattach live RPC processes.

Reload gates tool execution. `session_start` sets `reloading = true` before `replaceTeamManager`, `false` in `finally`. Every tool `execute` calls `ensureNotReloading()` first. `/team-on`/`/team-off` also call it. Read-only operator commands (`/team-prune`, `/team-cost`, `/agent-result`, …) skip the guard.

Scaffold-stale toasts are per-process de-duped. `Map<scope, scaffoldVersion>` ensures one warning per `(scope, scaffoldVersion)` per process lifetime. Pi fires `session_start` on startup/reload/new/resume/fork; without dedup, `/reload` spams.

Broadcasts swallow per-worker errors. `messageAllWorkers` / `cancelAllWorkers` collect failures into result array. One bad worker must never abort the whole broadcast.

Config precedence is by file presence, not validity. `agents-team.json` lives at `~/.pi/agent/` or `<cwd-ancestor>/.pi/agent/` (ancestor walk stops at `homedir()`). Project file present (valid, schema-mismatched, fatal-parse) → project wins outright. Invalid winning layer → built-in fallback for that scope; never downshifts. Fatal parse on non-winning layer is diagnostic-only. Full rules: [`docs/profiles.md`](docs/profiles.md).

`schemaVersion` vs `scaffoldVersion`. Both in `src/project-config/versions.ts`: schema=`4`, scaffold=`1`. Schema = parsing contract, breaking-change bump. Scaffold = content-freshness marker, soft "stale" toast only. When to bump: [`docs/profiles.md`](docs/profiles.md) "Version bumps".

Path scope is prompt convention, NOT OS sandbox. Tells worker where to focus; blocks "read-only profile with `write: true`" at delegate time. Does NOT contain `bash`, network, subprocess spawn, or a worker that ignores its prompt. If profile has `bash`, you trust the prompt.

User strings in prompts are fenced + length-capped. Role `name` ≤64, `whenToUse` / `description` ≤500. Sanitized + wrapped with `<!-- BEGIN available-profiles -->` sentinels before reaching orchestrator prompt. Defense against prompt-injection via crafted `whenToUse` in shared configs.

Config writes are atomic. `src/util/backup.ts#atomicWriteFileSync` stages to `<path>.tmp.<pid>.<ts>` and `renameSync`s into place. Backups: `copyFileSync` with `COPYFILE_EXCL`. Dirs `0o700`, files `0o600` (noop on Windows). `/team-enable`, `/team-disable`, `/team-on`, `/team-off`, `/team-init` use it; toggle commands shallow-merge into existing JSON so roles/`enabled`/`workerAccess` survive the patch.

Team profiles vs Pi skills. `delegate_task.profileName` = role from active config; `delegate_task.skills: string[]` = installed Pi skills worker should load. Which skills exist is install-specific; never bake skill names into prompts, examples, role defaults. Orchestrator's "Available worker profiles" block built dynamically from `config.profiles` at startup.

Cost totals: agents only. `aggregateUsage()` + widget `Σ` line sum tracked workers. Orchestrator cost stays in Pi's footer. Don't double-surface.

Routing mode is in-memory + always persisted on toggle. `TeamManager.routingMode` (`"team"` | `"solo"`) gates `delegate_task`, swaps orchestrator profile catalog for one-line solo directive, collapses widget to `Pi Agents Team — solo` when workers tracked (or hides widget entirely when none are). `setRoutingMode` emits `state_change`. Other `agent_*` tools stay callable in solo so live workers remain reachable. Initial mode from `deriveInitialRoutingMode`: `solo` when delegation off; otherwise `LoadedTeamProjectConfig.persistedRoutingMode` if present, else `team`. `/team-on` and `/team-off` auto-persist `routingMode` to the active `agents-team.json`. Target resolution: `--persist global|local` if passed; else `sourcePath` mapped back to scope via `deriveScopeFromSourcePath`; else fresh local stub at `<cwd>/.pi/agent/agents-team.json` (just `{schemaVersion, routingMode}`). `/team-init` seeds scaffold with `routingMode: "team"`. Don't put `routingMode` in `PersistedTeamState` — it's control-plane.

## Conventions

- Strict TypeScript, ESM. `node:test` + `node:assert/strict`. Never jest / vitest / bun.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas in extension entrypoint. Keep schemas and `TeamManager` params in sync.
- Tests use `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` (`setState`, `autoCompletePrompt: false`, `completePrompt()`).
- Profile prompts (`prompts/agents/*.md`) and specs (`profiles/*.md`) are parity-checked by `tests/prompts/` and `tests/profiles/`. Rename in both at once.
- `tests/control-plane/extension-wiring.test.ts` `deepEqual`s sorted command list — update when adding/dropping a command.
- Overlay tests strip ANSI before substring assertions via local `renderPlain(component, width)` helper (uses `stripAnsi` from `src/ui/theme.ts`). Don't assert on raw colored output.

## Anti-patterns

- Don't reintroduce `/team-status`, `/agents`, `/ping-agents`.
- Don't persist transcripts or raw events.
- Don't bypass `TeamManager` from commands.
- Don't emit toasts as conversation. Terminal/relay toasts are UI-only.
- Don't auto-prune terminal workers.
- Don't add orchestrator tokens to `Σ` row.
- Don't leave backward-compat shims (no `// removed for X`, no unused re-exports, no `_var` stubs).
- Don't add emojis to files unless asked.
- Don't widen `sanitizeText` strip regex to include `\x1b`. ESC must pass through for theme colors.
- Don't pre-block idle/waiting workers in overlay steer/message paths. `messageWorker` resolver upgrades to `prompt`. Only block unreachable terminal.

## Each turn

- Run `npm run check` before claiming correctness.
- Operator-facing change (commands, dashboard, tool params, delivery) → update [`README.md`](README.md) + [`docs/operations.md`](docs/operations.md) in same commit.
- Contract-level change (final_answer shape, worker responsibilities, wait semantics) → update [`prompts/orchestrator.md`](prompts/orchestrator.md) or relevant [`prompts/agents/*.md`](prompts/agents/).
- Before adding a command/tool: check whether widget or `/team` already covers it.
- Before touching state transitions: re-read invariants. Historical bugs cluster on status transitions and spurious toasts.
- Before changing overlay layout: check `OVERLAY_HEIGHT_PCT` ↔ `maxHeight` pairing and the row-budget regression test.

## Doc map

| File | Covers |
|---|---|
| [`README.md`](README.md) | overview, install, command table |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | local setup, test discipline, package layout |
| [`docs/architecture.md`](docs/architecture.md) | layering, runtime flow, state contract, animation, toasts, widget/overlay, routing-mode |
| [`docs/operations.md`](docs/operations.md) | dashboard keys, copy, steer/followup, routing toggle, troubleshooting |
| [`docs/profiles.md`](docs/profiles.md) | default roles, schema, prompt resolution, layering, version bumps, launch-time safety |
| [`docs/prompting.md`](docs/prompting.md) | orchestrator + worker prompt contracts, `<final_answer>` rules, wait-don't-poll |
| [`prompts/orchestrator.md`](prompts/orchestrator.md) | orchestrator contract injected on `before_agent_start` |
| [`prompts/agents/*.md`](prompts/agents/) | per-role worker contracts |
