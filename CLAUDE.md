# Agent

Load-bearing invariants and anti-patterns. Doc pointers at the bottom; don't duplicate them here.

## What this repo is

Pi extension. One visible Pi session = orchestrator; bounded work runs in background workers spawned via `pi --mode rpc --no-session`. Orchestrator keeps compact state (summary, relays, status, usage) plus each worker's `<final_answer>…</final_answer>` block. Never full transcripts.

Three non-negotiables:

1. One user-facing agent. Workers never speak to the user.
2. Background workers only. RPC, not nested chat sessions.
3. Compact state over transcripts. Persisted state stays small; raw assistant text only in-memory on `WorkerManager`.

## Dev commands

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # tsx --test tests/**/*.test.ts (node:test + assert/strict)
npm run check           # typecheck + test
npm run smoke:runtime   # scripts/smoke/runtime-worker.ts (real pi rpc worker)
npm run smoke:team      # scripts/smoke/team-flow.ts (TeamManager end-to-end)
```

Single test file: `tsx --test tests/runtime/worker-manager.test.ts`. Load locally: `pi -e ./extensions/index.ts`.

## Architecture

`extensions/index.ts` (re-export) → `extensions/pi-agent-team/index.ts` (tools, commands, UI wiring) → `src/control-plane/team-manager.ts` (single coordination boundary) → `src/runtime/` (worker process + RPC + event normalizer + worker manager) → `src/comms/`, `src/profiles/`, `src/safety/`, `src/prompts/`, `src/ui/`, `src/commands/`.

Commands are thin wrappers over `TeamManager`; never touch `WorkerManager` directly. Full topology: [`docs/architecture.md`](docs/architecture.md).

## Operator + tool surface

- 13 slash commands. See [`README.md`](README.md) and [`docs/operations.md`](docs/operations.md).
- 7 orchestrator tools (unchanged): `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.
- Overlay surface (`/team`): top tabs `Workers / Inspect / Console / Cost` (`1`–`4`, `tab` cycle), persistent action bar `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit`, inline single-line modal for `s` / `m` / `n`, live-tail Console wired to `getAssistantTail` + `onAssistantChunk`, header `solo` badge from `routingMode`, `[reuse]` tag on idle/waiting_followup roster rows.
- Deliberately removed, do NOT re-add without discussion: `/team-status`, `/agents`, `/ping-agents`. The widget + `/team` cover them.

## Load-bearing invariants

Terminal status set is canonical. `isTerminalWorkerStatus` = `idle | completed | aborted | error | exited`. `starting | running | waiting_followup` are non-terminal. Gates `wait_for_agents`, terminal toasts, widget glyph, "all" broadcasts, UI "done" states. Keep `deriveStatusFromSessionState` and `applyNormalizedEvent` aligned.

`starting → idle` race guard. `WorkerManager.launchWorker` calls `refreshState` before `promptWorker`; at that instant `isStreaming: false` would naively map to `idle` (terminal). The `worker_state` branch in `applyNormalizedEvent` keeps a `starting` worker as `starting` while `isStreaming` is false; `flushTerminalNotifications` re-filters queued toasts against current status. Both load-bearing. Guard scoped to `status === "starting" && !event.state.isStreaming`. Widening breaks running→idle; narrowing reintroduces spurious "worker finished" toasts.

Rejected prompt acceptance is terminal. `promptWorker` marks worker `running` before the RPC `prompt` call returns. If that call rejects, catch, mark `error`, emit state change, rethrow. No ghost-running workers.

Terminal workers reject messages. `messageWorker` throws when `worker.status` ∈ `UNREACHABLE_STATUSES` (`completed | aborted | error | exited`). `idle` and `waiting_followup` stay alive — RPC client still accepts prompts.

Delivery resolution is a 3-way union. `AgentMessageResult.delivery` = `"steer" | "follow_up" | "prompt"`. `steer`/`follow_up` only apply while streaming; on idle/waiting_followup both `/agent-steer` and `/agent-followup` upgrade to `"prompt"` (fresh RPC call wakes the session). Dropping the `"prompt"` case reintroduces the "queued but nothing happens" bug.

`wait_for_agents` wakes on relays. Resolves `all_terminal | relay_raised | timeout | aborted`. `relay_raised` carries `newRelays: {workerId, profileName, question, urgency}[]`. Baseline relay count snapshotted per call so already-answered relays don't wake. Opt out: `wakeOnRelay: false`. See [`docs/architecture.md`](docs/architecture.md) "Wait, don't poll".

Placeholder relay filter, 3 layers. Models drift and emit `relay_question: none | n/a | - | null`. (1) `extractRelayQuestions` filters against `PLACEHOLDER_RELAY_VALUES`; (2) relay-toast listener refuses empty/whitespace-only; (3) `buildWorkerTaskPrompt` tells models to omit the field. Remove any layer → "needs guidance: none" noise returns.

Summary file aliases are deliberate. `buildWorkerSummaryFromText` accepts `read_files`/`changed_files` AND `files_read`/`files_changed`. Workers and docs use both; dropping either hides file evidence from `/team`, `agent_result`, copy payloads.

Assistant-chunk ring buffer is bounded and never persisted. `WorkerManager` keeps a per-worker `assistantChunks` ring (`ASSISTANT_BUFFER_LINE_CAP = 4096` lines, `ASSISTANT_BUFFER_BYTE_CAP = 256 KB`) with monotonic per-task indexes. `getAssistantTail(workerId, fromIndex?)` returns chunks ≥ fromIndex; `onAssistantChunk(listener)` lets the overlay's Console tab live-tail without polling. Reuse resets the buffer (chunks empty, bytes 0, nextIndex 0) before re-prompting. The transcript invariant still holds: nothing in this buffer ever lands on disk; `config.persistence.storeTranscripts` stays `false`.

Close vs cancel vs prune are distinct. `cancelWorker` aborts a running stream and SIGTERMs the process; final status `exited` (or `aborted` on race). `closeWorker` disposes the RPC of an idle/waiting_followup worker and sets the `closing` flag so `worker_exit` lands as `exited` not `aborted`; running/starting workers reject `closeWorker`. `pruneTerminalWorkers` is async; for every terminal entry it calls `WorkerManager.removeWorker`, which awaits handle disposal for any reusable worker still holding a live session, then drops the registry entry. No auto-prune on terminal transition: operators want batch history until `/team-prune`. The old "prune never touches live processes" rule is gone. Idle workers ARE terminal but still hold live RPC, and prune now disposes that handle to stop leaking processes.

Reuse is launch-strict. `delegate_task.reuseWorkerId` re-prompts an existing idle/waiting_followup worker's RPC session instead of spawning. Process-launch flags (`model`, `tools`, `cwd`, `systemPromptPath`, `extensionMode`, `thinkingLevel`, `allowSkills`) are baked at spawn and cannot change for the worker's lifetime. `WorkerManager` snapshots them on `launchWorker` (`record.launchSnapshot`); `TeamManager.reuseWorkerForTask` recomputes the would-be launch plan via `applyLaunchPolicy` and rejects with a per-field error string when any baked field differs. Cross-profile reuse is also rejected (different role = different prompt). Reuse resets per-task state (`textBuffer`, `finalAnswer`, `lastTool`, `relayQuestions`, `lastSummary`, `error`) before re-prompting; the rejected-prompt invariant from `promptWorker` still applies if the RPC fails.

`closing` flag is load-bearing. `WorkerRuntimeRecord.closing` lets `closeWorker` distinguish operator-initiated disposal from a crash. Without it, the natural `worker_exit` event fired by `handle.dispose()` would map `SIGTERM` to `aborted`, lying about why the worker stopped. `closeWorker` sets `closing = true`, then disposes; the `worker_exit` branch in `applyNormalizedEvent` checks the flag and forces `exited`. Don't reuse the flag for other paths; cancel does not set it (cancel intent really is "abort").

Widget spinner timer. 120 ms `setInterval` while `hasAnimatedWorkers(state)` is true. Starts on state change, stops when last non-terminal worker finishes, stops on `session_shutdown`, `.unref()`s. Touching cadence/animation condition? Stop the old timer first.

Visible-width in all TUI code. Widget and overlay use pi-tui's `visibleWidth` / `truncateToWidth`. Never raw `.length` / `.slice`. Braille spinners, emoji, combining chars miscount under code-unit length and crash pi-tui's render validator.

Session restore is honest. `markRestoredWorkersExited` flips every restored worker to `exited` on session start. Handler threads `SessionStartEvent.reason` through the error string and emits one decorative warning toast when `reason !== "startup"` and ≥1 worker was flipped. Never silently reattach live RPC processes.

Reload gates tool execution. `session_start` sets `reloading = true` before `replaceTeamManager`, `false` in `finally`. Every tool `execute` calls `ensureNotReloading()` first. `/team-on` and `/team-off` also call it (toggling during the swap window otherwise lands on a soon-to-be-disposed `TeamManager`). Read-only operator commands (`/team-prune`, `/team-cost`, `/agent-result`, …) don't need the guard.

Scaffold-stale toasts are per-process de-duped. `Map<scope, scaffoldVersion>` ensures one warning per `(scope, scaffoldVersion)` per process lifetime. Pi fires `session_start` on startup/reload/new/resume/fork; without dedup, `/reload` iterations spam.

Broadcasts swallow per-worker errors. `messageAllWorkers` / `cancelAllWorkers` collect failures into the result array. One bad worker must never abort the whole broadcast.

Config precedence is by file presence, not validity. `agents-team.json` lives at `~/.pi/agent/` or `<cwd-ancestor>/.pi/agent/` (ancestor walk stops at `homedir()`). Project file present (valid, schema-mismatched, or fatal-parse) → project wins outright. Invalid winning layer → built-in fallback for that scope; never downshifts to the other layer. Fatal parse on NON-winning layer is diagnostic-only. Full rules: [`docs/profiles.md`](docs/profiles.md).

`schemaVersion` vs `scaffoldVersion`. Both in `src/project-config/versions.ts`: schema=`4`, scaffold=`1`. Schema = parsing contract, breaking-change bump. Scaffold = content-freshness marker, soft "stale" toast only. When-to-bump: [`docs/profiles.md`](docs/profiles.md) "Version bumps".

Path scope is a prompt convention, NOT an OS sandbox. Tells the worker where to focus and blocks the "read-only profile with `write: true`" case at delegate time. Does NOT contain `bash`, network, subprocess spawning, or a worker that ignores its prompt. If a profile has `bash`, you trust the prompt. Framing + what `resolvePathScope` / `normalizePathScope` enforce: [`docs/architecture.md`](docs/architecture.md).

User strings in prompts are fenced + length-capped. Role `name` ≤64, `whenToUse` / `description` ≤500. Sanitized and wrapped with `<!-- BEGIN available-profiles -->` sentinels before reaching the orchestrator prompt. Defense against prompt-injection via crafted `whenToUse` in shared configs.

Config writes are atomic. `src/util/backup.ts#atomicWriteFileSync` stages to `<path>.tmp.<pid>.<ts>` and `renameSync`s into place. Backups: `copyFileSync` with `COPYFILE_EXCL`. Dirs `0o700`, files `0o600` (noop on Windows). `/team-enable`, `/team-disable`, `/team-on --persist`, `/team-off --persist` all use it; toggle commands never rewrite a valid config's roles, only patch their target field (`enabled` or `routingMode`).

Team profiles and Pi skills are different axes. `delegate_task.profileName` is a role from the active config; `delegate_task.skills: string[]` names installed Pi skills the worker should load and apply from its available skill context. Which skills exist is install-specific — never bake skill names into prompts, examples, or role defaults. The orchestrator's "Available worker profiles" block is built dynamically from `config.profiles` at startup.

Cost totals: agents only. `aggregateUsage()` and the widget `Σ` line sum tracked workers. Orchestrator cost stays in Pi's footer. Don't double-surface.

Routing mode is in-memory + optionally persisted. `TeamManager.routingMode` (`"team"` | `"solo"`) gates `delegate_task`, swaps the orchestrator profile catalog for a one-line solo directive, collapses the widget to a single `Pi Agents Team — solo` line when workers are tracked (or hides the widget entirely when none are). `setRoutingMode` emits `state_change`. Other `agent_*` tools stay callable in solo so live workers remain reachable. Initial mode from `deriveInitialRoutingMode`: `solo` when delegation is off; otherwise `LoadedTeamProjectConfig.persistedRoutingMode` if present, else `team`. `/team-on` / `/team-off [--persist global|local]` writes `routingMode` to scoped `agents-team.json`; loader reads it back via `persistedRoutingMode`. Don't put routingMode in `PersistedTeamState` — it's control-plane, not registry state.

## Conventions

- Strict TypeScript, ESM (`"type": "module"`). `node:test` + `node:assert/strict`. Never jest / vitest / bun.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas in the extension entrypoint. Keep schemas and `TeamManager` params in sync.
- Tests use `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` (`setState`, `autoCompletePrompt: false`, `completePrompt()`).
- Profile prompts (`prompts/agents/*.md`) and specs (`profiles/*.md`) are parity-checked by `tests/prompts/` and `tests/profiles/`. Rename in both places at once.
- `tests/control-plane/extension-wiring.test.ts` `deepEqual`s the sorted command list — update when you add or drop a command.

## Anti-patterns

- Don't reintroduce `/team-status`, `/agents`, `/ping-agents`. Surface in `/team` or the widget instead.
- Don't persist transcripts or raw events. In-memory buffers on `WorkerManager` are deliberate; `config.persistence.storeTranscripts === false`.
- Don't bypass `TeamManager` from commands. Control plane is the single boundary.
- Don't emit toasts as if they were conversation. Terminal/relay toasts are UI-only; orchestrator prompt tells the LLM to ignore them.
- Don't auto-prune terminal workers. Hides cancelled runs before inspection; breaks `Σ` "spent in this batch" semantics.
- Don't add orchestrator tokens to the `Σ` row. Pi's footer already shows them.
- Don't leave backward-compat shims. No `// removed for X`, no unused re-exports, no renamed `_var` stubs. Git history is the record.
- Don't add emojis to files unless asked. Widget uses braille spinner + ASCII glyphs on purpose.

## Each turn

- Run `npm run check` before claiming correctness.
- Operator-facing change (commands, dashboard, tool params, delivery semantics) → update [`README.md`](README.md) + [`docs/operations.md`](docs/operations.md) in the same commit.
- Contract-level change (final_answer shape, worker responsibilities, wait semantics) → update [`prompts/orchestrator.md`](prompts/orchestrator.md) or relevant [`prompts/agents/*.md`](prompts/agents/). The LLM reads those.
- Before adding a command/tool: check whether the widget or `/team` already covers the need.
- Before touching state transitions: re-read invariants. Historical bugs cluster on status transitions and spurious toasts.

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
| [`prompts/agents/*.md`](prompts/agents/) | per-role worker contracts, loaded at launch |
