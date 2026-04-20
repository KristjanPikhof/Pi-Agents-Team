# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Pi extension that turns one visible Pi session into an **orchestrator** and runs all bounded work in background **worker** Pi sessions spawned via `pi --mode rpc --no-session`. The orchestrator never mirrors worker transcripts into its own context — it keeps compact state (summary, relays, status, usage) plus the worker's `<final_answer>…</final_answer>` block and synthesizes from that.

The product contract has three non-negotiables. If you find yourself about to break one, stop and ask:

1. One user-facing agent. Workers never speak to the user.
2. Background workers only. They run through RPC, not nested chat sessions.
3. Compact state over transcripts. Persisted state must stay small and truthful; raw assistant text lives only in-memory on `WorkerManager`.

## Commands

```bash
npm install
npm run typecheck           # tsc --noEmit
npm test                    # tsx --test tests/**/*.test.ts (node:test runner)
npm run smoke:runtime       # scripts/smoke/runtime-worker.ts — real pi rpc worker
npm run smoke:team          # scripts/smoke/team-flow.ts — TeamManager end-to-end
```

Run one test file: `tsx --test tests/runtime/worker-manager.test.ts`. Assertions come from `node:assert/strict` — not bun, jest, or vitest.

Load the extension into Pi for manual verification:
```bash
pi -e ./extensions/pi-agent-team/index.ts
pi -e ./extensions/pi-agent-team/index.ts -p "/team"
```

Current test count is 44. If a change reduces that without a corresponding deletion, something regressed.

## Architecture

Layering, top to bottom:

- `extensions/pi-agent-team/index.ts` — extension entrypoint. Registers 7 tools, 6 slash commands, lifecycle hooks, the state-change listener that drives UI + notifications + spinner animation, and the terminal-toast batcher.
- `src/control-plane/team-manager.ts` — `TeamManager` is the single coordination boundary. Owns a `TaskRegistry` and a `WorkerManager`. Public shape: `delegateTask`, `messageWorker` / `messageAllWorkers`, `cancelWorker` / `cancelAllWorkers`, `pingWorkers`, `waitForTerminal`, `getWorkerResult`, `getWorkerTranscript`, `getWorkerConsole`.
- `src/runtime/` — RPC transport. `worker-process.ts` spawns the Pi rpc process, `rpc-client.ts` wraps the line-delimited JSON protocol, `event-normalizer.ts` collapses raw RPC events into a stable `NormalizedWorkerEvent` union, `worker-manager.ts` applies those events to `WorkerRuntimeState` and emits snapshots.
- `src/comms/` — message shaping. `summary.ts` parses the worker's structured summary, `relay-queue.ts` extracts `relay_question` + `assumption`, `agent-messaging.ts` picks `steer` vs `follow_up` based on status, `ping.ts` builds passive snapshots.
- `src/profiles/` + `profiles/*.md` — packaged roles (explorer, fixer, reviewer, librarian, observer, oracle, designer). Loader reads markdown frontmatter; `default-profiles.ts` has the TS specs.
- `src/safety/` — `launch-policy.ts` gates every `delegate_task` (extension mode, path scope, recursion block); `path-scope.ts` requires explicit writable roots for scoped-write profiles (today only `fixer`).
- `src/prompts/contracts.ts` — builds the orchestrator system-prompt bundle and the per-task worker prompt. `buildWorkerTaskPrompt` injects the `<final_answer>` contract.
- `src/ui/` — `status-widget.ts` (always-visible widget with spinner + counts + per-worker lines), `overlay.ts` (interactive `/team` dashboard with Summary/Console tabs), `dashboard.ts` (print-mode fallback text), `copy-payload.ts` (shared copy-to-clipboard formatter).
- `src/util/clipboard.ts` — platform-aware clipboard (pbcopy / clip.exe / wl-copy / xclip / xsel).
- `src/commands/` — `team.ts`, `steer.ts`, `cancel.ts`, `copy.ts`. Every command delegates to `TeamManager`; they never hit `WorkerManager` directly.

## Operator surface (post-cleanup)

**Slash commands — 6 total.**

- `/team` → opens the dashboard overlay (live RPC ping on open).
- `/team <worker-id>` → jumps straight into that worker's detail view.
- `/team-copy <worker-id>` → copies task + summary + final answer + transcript + console timeline to the system clipboard.
- `/agent-result <worker-id>` → prints the compact summary + verbatim `<final_answer>` block.
- `/agent-steer <worker-id|all> <msg>` → auto-routes: `steer` if running, `follow_up` if idle/waiting_followup. Prints the mode used.
- `/agent-followup <worker-id|all> <msg>` → always queues as `follow_up`.
- `/agent-cancel <worker-id|all>` → aborts one or every non-terminal worker.

**Deliberately removed** (do not re-add without discussion):

- `/team-status` — widget + `src/config.ts` already show everything it printed.
- `/agents` — subsumed by the widget (glyph + id + profile + detail) and `/team`.
- `/ping-agents` — the unique RPC-refresh effect moved into `/team` (fires on open, and on `r` inside the overlay).

**Tools — 7 total, unchanged** (the orchestrator LLM uses these, not humans): `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.

## Key invariants worth preserving

**Compact state, not transcripts.** `createPersistedStateSnapshot` stores compact summaries + relays + status. Raw assistant text lives in-memory on `WorkerManager.textBuffer` and a bounded console ring (`CONSOLE_BUFFER_LIMIT`). Never pipe transcripts into orchestrator context. `config.persistence.storeTranscripts` is `false`.

**Terminal status set is canonical.** `isTerminalWorkerStatus` recognizes `idle`, `completed`, `aborted`, `error`, `exited`. This gates `wait_for_agents`, terminal toasts, the widget glyph, "all" broadcasts, and UI "done" states. `starting`, `running`, `waiting_followup` are non-terminal. Keep `deriveStatusFromSessionState` and `applyNormalizedEvent` aligned with this set.

**`wait_for_agents` wakes on relays.** `waitForTerminal` resolves with four possible `reason` values: `all_terminal`, `relay_raised`, `timeout`, `aborted`. On `relay_raised`, the result includes `newRelays: [{workerId, profileName, question, urgency}]` so the orchestrator can answer without enumerating workers. The baseline relay count is snapshotted per call — already-answered relays don't wake subsequent waits. Pass `wakeOnRelay: false` to opt out. The orchestrator prompt covers this loop (`prompts/orchestrator.md`); the extension tool description covers it too. Don't revert to "wait for all terminal" as the only exit — that's how the orchestrator handled 10 parallel workers with mid-flight questions before this change and it blocked productive work.

**The `starting → idle` race guard.** `WorkerManager.launchWorker` calls `refreshState` before `promptWorker`. At that instant the RPC session reports `isStreaming: false`, which naively maps to `idle` (terminal). The `worker_state` branch in `applyNormalizedEvent` keeps a `starting` worker as `starting` while `isStreaming` is false. `flushTerminalNotifications` in the extension filters queued toast entries against current status. Both pieces are load-bearing — touching either without updating the other reintroduces spurious "worker finished" toasts.

**The `<final_answer>` contract.** Every delegated task prompt requires the worker's final assistant message to wrap the deliverable in a single `<final_answer>…</final_answer>` block. `extractFinalAnswer` pulls it into `WorkerRuntimeState.finalAnswer`. If the block is empty, the orchestrator's job is to re-delegate / steer / cancel — not to run investigation tools directly.

**Non-recursive workers.** Default `extensionMode` is `worker-minimal`. `config.safety.preventRecursiveOrchestrator` is `true` and `launch-policy.ts` hard-rejects `extensionMode: "inherit"` so workers never boot the orchestrator package recursively.

**Session restore is honest.** `markRestoredWorkersExited` forces every restored worker to `exited` on session start. Do not try to reattach live RPC processes silently — orphaned state is worse than forcing a relaunch.

**Broadcasts swallow per-worker errors.** `messageAllWorkers` and `cancelAllWorkers` collect failures into the returned result array (setting `error`) rather than throwing. One bad worker must never abort the whole broadcast. Preserve this when extending.

**Delivery resolution is explicit.** `messageWorker` returns `AgentMessageResult` with the resolved `delivery` field (`"steer" | "follow_up"`). UI and commands use this to tell the user which channel the message actually went down. Don't drop this field.

**Widget spinner timer.** A 120 ms `setInterval` animates the widget while `hasAnimatedWorkers(state)` is true. It starts on state change, stops on the last worker going terminal, stops on `session_shutdown`, and calls `.unref()` so it never blocks process exit. If you change the tick cadence or the animation condition, stop the old timer.

**Overlay footer is pinned at the top.** Under the tabs, not the bottom. This is intentional — terminals can clip the overlay and a bottom footer would disappear. A transient `» …` status line shows copy/refresh outcomes for ~2.5s.

## Conventions

- Strict TypeScript, ESM (`"type": "module"`). Tests use `node:test` + `node:assert/strict`.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas in the extension entrypoint. Keep schemas and the params shape passed to `TeamManager` in sync.
- Tests lean on `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` instead of spawning real `pi` processes. `MockWorkerTransport.setState(patch)` mutates `isStreaming` and friends from outside; `autoCompletePrompt: false` lets tests drive the exit event manually via `completePrompt()`.
- Profile prompts (`prompts/agents/*.md`) and profile specs (`profiles/*.md`) are validated by `tests/prompts/prompt-files.test.ts` and `tests/profiles/loader.test.ts` — add or rename a profile in both places at once.
- `extension-wiring.test.ts` uses `deepEqual` on the sorted command list. Adding or dropping a slash command means updating that assertion too.

## Documentation map (keep up to date)

- [`README.md`](README.md) — product overview, quick start, command + tool tables.
- [`docs/architecture.md`](docs/architecture.md) — layering, runtime flow, state contract, animation layer, toast rules.
- [`docs/operations.md`](docs/operations.md) — install, smoke, dashboard keys, copy flow, steer/followup semantics, troubleshooting.
- [`docs/profiles.md`](docs/profiles.md) — default profile table, launch policy, customization.
- [`docs/prompting.md`](docs/prompting.md) — orchestrator + worker prompt contracts, the `<final_answer>` block rules, wait-don't-poll discipline.
- [`prompts/orchestrator.md`](prompts/orchestrator.md) — the orchestrator contract injected on `before_agent_start`. This is shipped to the LLM, not just the user.
- [`prompts/agents/*.md`](prompts/agents/) — per-role worker contracts, loaded at worker launch.

When operator-facing behavior changes (commands, dashboard keys, glyphs, tool parameters, delivery semantics) update the README command table and the operations guide in the same change. When contract-level behavior changes (final_answer shape, worker responsibilities, wait semantics) update `prompts/orchestrator.md` or the relevant `prompts/agents/*.md` too — the LLM reads those directly.

## Anti-patterns to avoid

- **Don't reintroduce `/team-status`, `/agents`, or `/ping-agents`.** They were removed for a reason (widget + `/team` cover it). If you think one is needed, surface the missing capability in `/team` or the widget instead.
- **Don't persist transcripts or raw events.** The `WorkerManager` buffers them in memory on purpose. If you find yourself adding a field to `PersistedTeamState` that stores text beyond a summary, stop.
- **Don't over-guard `worker_state`.** The guard only applies when `status === "starting" && !event.state.isStreaming`. Any wider guard breaks the running → idle transition. Any narrower guard reintroduces the spurious-toast bug.
- **Don't emit toasts as if they were conversation.** Terminal-status toasts and relay-question toasts are UI-only. The orchestrator prompt explicitly tells the LLM to ignore them. If you add a new toast type, make sure it's purely decorative.
- **Don't bypass `TeamManager` from commands.** Commands are thin wrappers over `TeamManager` methods. Keep that boundary; the control plane is the only place that touches the registry and the runtime.
- **Don't add emojis to files** unless the user asks. The widget uses braille spinner + ASCII-like glyphs on purpose.
- **Don't leave backward-compat shims.** If something is removed, delete it completely — no `// removed for X`, no unused re-exports, no renamed `_var` stubs. Git history is the record.

## What to do on each turn

- Before claiming code is correct: run `npm run typecheck` and `npm test`. Don't ship red tests.
- Before claiming a behavior change is done: update the relevant doc (README, `docs/*.md`, or `prompts/*.md`).
- Before adding a command or tool: check whether the widget or `/team` already covers the need.
- Before touching runtime state transitions: re-read the "Key invariants" section above. The bugs in this codebase have historically been race conditions on status transitions and spurious toasts — those are the expensive classes of mistake.
- Before changing the MockWorkerTransport shape: check which tests rely on `autoCompletePrompt`, `promptText`, and `setState`. They are the only seam for unit-testing runtime behavior without a real Pi process.
