# Agent

Load-bearing invariants and anti-patterns for agents working in this repo. For everything else, follow the doc pointers at the end — don't duplicate them here.

## What this repo is

A Pi extension that turns one visible Pi session into an **orchestrator** and runs all bounded work in background **worker** Pi sessions spawned via `pi --mode rpc --no-session`. The orchestrator keeps compact state (summary, relays, status, usage) plus each worker's `<final_answer>…</final_answer>` block — never full transcripts.

Three non-negotiables. If you are about to break one, stop and ask:

1. **One user-facing agent.** Workers never speak to the user.
2. **Background workers only.** They run through RPC, not nested chat sessions.
3. **Compact state over transcripts.** Persisted state stays small and truthful; raw assistant text lives only in-memory on `WorkerManager`.

## Dev commands

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # tsx --test tests/**/*.test.ts (node:test + node:assert/strict)
npm run check              # typecheck + test
npm run smoke:runtime      # scripts/smoke/runtime-worker.ts — real pi rpc worker
npm run smoke:team         # scripts/smoke/team-flow.ts — TeamManager end-to-end
```

Single test file: `tsx --test tests/runtime/worker-manager.test.ts`. Load the extension locally: `pi -e ./extensions/index.ts`.

## Architecture at a glance

Top-down: `extensions/index.ts` (package entrypoint, thin re-export) → `extensions/pi-agent-team/index.ts` (implementation entrypoint — tools, commands, UI wiring) → `src/control-plane/team-manager.ts` (single coordination boundary) → `src/runtime/` (worker process + RPC + event normalizer + worker manager) → supporting layers (`src/comms/`, `src/profiles/`, `src/safety/`, `src/prompts/`, `src/ui/`, `src/commands/`).

Commands are thin wrappers over `TeamManager` methods and never touch `WorkerManager` directly.

Full runtime topology and data flow: [`docs/architecture.md`](docs/architecture.md).

## Operator and tool surface

- **Slash commands** (11): see [`README.md`](README.md) command table and [`docs/operations.md`](docs/operations.md) for semantics.
- **Orchestrator tools** (7, unchanged): `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.

**Deliberately removed — do not re-add without discussion:** `/team-status`, `/agents`, `/ping-agents`. The widget + `/team` cover them.

## Load-bearing invariants

**Terminal status set is canonical.** `isTerminalWorkerStatus` recognizes `idle | completed | aborted | error | exited`. `starting | running | waiting_followup` are non-terminal. This set gates `wait_for_agents`, terminal toasts, the widget glyph, "all" broadcasts, and UI "done" states. Keep `deriveStatusFromSessionState` and `applyNormalizedEvent` aligned.

**The `starting → idle` race guard.** `WorkerManager.launchWorker` calls `refreshState` before `promptWorker`. At that instant `isStreaming: false` naively maps to `idle` (terminal). The `worker_state` branch in `applyNormalizedEvent` keeps a `starting` worker as `starting` while `isStreaming` is false; `flushTerminalNotifications` re-filters queued toasts against current status. Both pieces are load-bearing — touching either reintroduces spurious "worker finished" toasts. The guard is scoped to `status === "starting" && !event.state.isStreaming`; widening it breaks running→idle, narrowing reintroduces the bug.

**Rejected prompt acceptance is terminal.** `promptWorker` marks a worker `running` before the RPC `prompt` call returns. If that call rejects, catch it, mark the worker `error`, emit the state change, and rethrow. Never leave a rejected prompt as a ghost-running worker.

**Terminal workers reject messages.** `messageWorker` throws when `worker.status` is in `UNREACHABLE_STATUSES` (`completed | aborted | error | exited`). `idle` and `waiting_followup` stay alive — the RPC client still accepts prompts.

**Delivery resolution is a 3-way union.** `AgentMessageResult.delivery` is `"steer" | "follow_up" | "prompt"`. `steer`/`follow_up` only apply while streaming; on idle/waiting_followup both `/agent-steer` and `/agent-followup` upgrade to `"prompt"` (fresh RPC call that wakes the session). Dropping the `"prompt"` case reintroduces the "queued but nothing happens" bug.

**`wait_for_agents` wakes on relays.** Resolves with `all_terminal | relay_raised | timeout | aborted`. On `relay_raised`, `newRelays` carries `{workerId, profileName, question, urgency}`. Baseline relay count is snapshotted per call so already-answered relays don't wake. Opt out with `wakeOnRelay: false`. Don't revert to terminal-only — see [`docs/architecture.md`](docs/architecture.md) "Wait, don't poll".

**Placeholder relay filter — 3 layers.** Models drift and emit `relay_question: none | n/a | - | null`. (1) `extractRelayQuestions` filters against `PLACEHOLDER_RELAY_VALUES`, (2) the relay-toast listener refuses empty/whitespace-only questions, (3) `buildWorkerTaskPrompt` tells models to omit the field. Remove any one and the "needs guidance: none" noise comes back.

**Summary file aliases are deliberate.** `buildWorkerSummaryFromText` accepts both `read_files`/`changed_files` and `files_read`/`files_changed`. Workers and docs have used both families; dropping either hides useful file evidence from `/team`, `agent_result`, and copy payloads.

**Prune is not cancel.** `cancelWorker` kills the RPC process and marks the entry `exited` but keeps it. `pruneTerminalWorkers` only removes already-terminal entries, never touches live processes. No auto-prune on terminal transition — operators want a batch history until they clear it with `/team-prune`.

**Widget spinner timer.** 120 ms `setInterval` animates while `hasAnimatedWorkers(state)` is true. Starts on state change, stops when the last non-terminal worker finishes, stops on `session_shutdown`, and `.unref()`s. Touch the cadence or animation condition? Stop the old timer.

**Visible-width in all TUI code.** Widget and overlay use pi-tui's `visibleWidth` / `truncateToWidth` — never raw `.length` / `.slice`. Braille spinners, emoji, and combining chars miscount under code-unit length and crash pi-tui's render validator.

**Session restore is honest.** `markRestoredWorkersExited` forces every restored worker to `exited` on session start. The handler threads `SessionStartEvent.reason` through the error string and emits a single decorative warning toast when `reason !== "startup"` and at least one worker was flipped. Never try to silently reattach live RPC processes.

**Reload gates tool execution.** `session_start` sets `reloading = true` before `replaceTeamManager` and `false` in `finally`. Every tool `execute` calls `ensureNotReloading()` first. Read-only operator commands (`/team-prune`, `/team-cost`, `/agent-result`, …) don't need the guard.

**Scaffold-stale toasts are per-process de-duped.** `Map<scope, scaffoldVersion>` ensures one warning per `(scope, scaffoldVersion)` per lifetime. Pi fires `session_start` on startup, reload, new, resume, and fork — without dedup, `/reload` iterations spam.

**Broadcasts swallow per-worker errors.** `messageAllWorkers` / `cancelAllWorkers` collect failures into the result array; one bad worker must never abort the whole broadcast.

**Config precedence is by file presence, not validity.** `agents-team.json` lives at `~/.pi/agent/` or `<cwd-ancestor>/.pi/agent/` (ancestor walk stops at `homedir()`). If a project file exists — valid, schema-mismatched, or fatal-parse — project wins outright. An invalid winning layer falls back to built-ins; it never downshifts to the other layer. Fatal parse on a NON-winning layer is diagnostic-only. Full rules and prompt resolution: [`docs/profiles.md`](docs/profiles.md).

**`schemaVersion` vs `scaffoldVersion`.** Two counters, both in `src/project-config/versions.ts` (currently both `3`). Schema = parsing contract, breaking-change bump. Scaffold = content-freshness marker, soft "stale" warning only. Full distinction and when to bump which: [`docs/profiles.md`](docs/profiles.md) "Version bumps".

**Path scope is a prompt convention, not an OS sandbox.** It tells the worker where to focus and blocks the clear-cut "read-only profile with `write: true`" case at delegate time. It does NOT contain `bash`, network, subprocess spawning, or a worker that ignores its prompt. If you include `bash` in a profile, trust the prompt. Full framing and what `resolvePathScope` / `normalizePathScope` actually enforce: [`docs/architecture.md`](docs/architecture.md).

**User strings in prompts are fenced and length-capped.** Role `name` (≤64), `whenToUse` / `description` (≤500) are sanitized and wrapped with `<!-- BEGIN available-profiles -->` sentinels before reaching the orchestrator prompt. Defense against prompt-injection via crafted `whenToUse` in shared configs.

**Config writes are atomic.** `src/util/backup.ts#atomicWriteFileSync` stages to `<path>.tmp.<pid>.<ts>` and `renameSync`es into place. Backups use `copyFileSync` with `COPYFILE_EXCL`. Dirs `0o700`, files `0o600` (noop on Windows). Toggle commands (`/team-enable`, `/team-disable`) never rewrite a valid config's roles — only patch `enabled`.

**Team profiles and Pi skills are different axes.** `delegate_task.profileName` is a role from the active config; `delegate_task.skills: string[]` names installed Pi skills the worker should load and apply from its available skill context. Which skills exist is install-specific — never bake specific skill names into prompts, examples, or role defaults. The orchestrator's **Available worker profiles** block is built dynamically from `config.profiles` at startup.

**Cost totals: agents only.** `aggregateUsage()` and the widget `Σ` line sum tracked workers. Orchestrator cost stays in Pi's footer. Don't double-surface.

## Conventions

- Strict TypeScript, ESM (`"type": "module"`). `node:test` + `node:assert/strict` — never jest / vitest / bun.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas in the extension entrypoint. Keep schemas and the params shape passed to `TeamManager` in sync.
- Tests use `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` (`setState`, `autoCompletePrompt: false`, `completePrompt()`) — the seam for unit-testing runtime without a real `pi` process.
- Profile prompts (`prompts/agents/*.md`) and specs (`profiles/*.md`) are parity-checked by `tests/prompts/` and `tests/profiles/` — rename in both places at once.
- `tests/extension-wiring.test.ts` `deepEqual`s the sorted command list — update when you add or drop one.

## Anti-patterns

- **Don't reintroduce `/team-status`, `/agents`, `/ping-agents`.** If you think one is needed, surface the capability in `/team` or the widget instead.
- **Don't persist transcripts or raw events.** In-memory buffers on `WorkerManager` are deliberate; `config.persistence.storeTranscripts` is `false`.
- **Don't bypass `TeamManager` from commands.** Control plane is the single boundary that touches the registry and runtime.
- **Don't emit toasts as if they were conversation.** Terminal and relay toasts are UI-only; the orchestrator prompt tells the LLM to ignore them.
- **Don't auto-prune terminal workers.** Hides cancelled runs before inspection; breaks `Σ` "spent in this batch" semantics.
- **Don't add orchestrator tokens to the `Σ` row.** Pi's footer already shows them.
- **Don't leave backward-compat shims.** No `// removed for X`, no unused re-exports, no renamed `_var` stubs. Git history is the record.
- **Don't add emojis to files** unless the user asks. Widget uses braille spinner + ASCII glyphs on purpose.

## What to do each turn

- Run `npm run check` (or `npm run typecheck` + `npm test`) before claiming correctness.
- Update the relevant doc when operator-facing behavior (commands, dashboard, tool params, delivery semantics) changes — [`README.md`](README.md) and [`docs/operations.md`](docs/operations.md) in the same commit.
- Update [`prompts/orchestrator.md`](prompts/orchestrator.md) or the relevant [`prompts/agents/*.md`](prompts/agents/) when contract-level behavior (final_answer shape, worker responsibilities, wait semantics) changes — the LLM reads those directly.
- Before adding a command or tool: check whether the widget or `/team` already covers the need.
- Before touching runtime state transitions: re-read the invariants above. Historical bugs cluster on status transitions and spurious toasts.

## Documentation map

- [`README.md`](README.md) — product overview, install, operator command table.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, test discipline, package layout.
- [`docs/architecture.md`](docs/architecture.md) — layering, runtime flow, state contract, animation, toast rules, widget/overlay layout.
- [`docs/operations.md`](docs/operations.md) — dashboard keys, copy flow, steer/followup semantics, troubleshooting.
- [`docs/profiles.md`](docs/profiles.md) — default roles, `agents-team.json` schema, prompt resolution, layering, version bumps, launch-time safety.
- [`docs/prompting.md`](docs/prompting.md) — orchestrator + worker prompt contracts, `<final_answer>` rules, wait-don't-poll discipline.
- [`prompts/orchestrator.md`](prompts/orchestrator.md) — orchestrator contract injected on `before_agent_start` (planning loop + task brief template). Shipped to the LLM.
- [`prompts/agents/*.md`](prompts/agents/) — per-role worker contracts, loaded at launch.
