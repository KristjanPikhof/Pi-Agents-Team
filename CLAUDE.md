# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install deps (peer deps: @mariozechner/pi-coding-agent, pi-tui, @sinclair/typebox)
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test tests/**/*.test.ts (node:test runner)
npm run smoke:runtime    # scripts/smoke/runtime-worker.ts — exercises WorkerManager against a real pi rpc worker
npm run smoke:team       # scripts/smoke/team-flow.ts — exercises TeamManager end-to-end
```

Run a single test file: `tsx --test tests/runtime/worker-manager.test.ts`. The project uses `node:test`, not bun/jest/vitest — assertions come from `node:assert/strict`.

Load the extension into Pi for manual verification: `pi -e ./extensions/pi-agent-team/index.ts -p "/team-status"`.

## Architecture

This package is a Pi extension that turns one visible Pi session into an **orchestrator** that launches and supervises background **worker** Pi sessions via `pi --mode rpc`. The orchestrator is the only user-facing agent; workers never talk to the user directly and their state is compacted (summaries, relay questions, status) rather than streamed back into the orchestrator's context window.

### Layering (top-down)

- `extensions/pi-agent-team/index.ts` — extension entrypoint. Registers tools (`delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`), slash commands, lifecycle hooks, and the UI listeners. Holds the in-process `TeamManager` instance and its `onStateChange` subscriber that drives UI widgets and toast notifications.
- `src/control-plane/team-manager.ts` — `TeamManager` is the single coordination boundary. It owns a `TaskRegistry` (task/worker state, `snapshot()`, `restore()`) and a `WorkerManager`. Delegation flow: `resolveProfile → applyLaunchPolicy → registerTask → workerManager.launchWorker → workerManager.promptWorker`. Status changes emit `state_change` events consumed by the extension and by `waitForTerminal` (which is how `wait_for_agents` avoids polling).
- `src/runtime/` — RPC transport. `worker-process.ts` spawns `pi --mode rpc`; `rpc-client.ts` wraps the line-delimited JSON protocol; `event-normalizer.ts` collapses raw RPC events into a stable `NormalizedWorkerEvent` union; `worker-manager.ts` applies those normalized events to a `WorkerRuntimeState` per worker and emits snapshots.
- `src/comms/` — helpers that shape worker ↔ orchestrator traffic: `summary.ts` parses the worker's structured summary blocks, `relay-queue.ts` extracts relay questions from assistant text, `ping.ts` builds passive ping summaries, `agent-messaging.ts` decides between `steer` (interrupt) and `follow_up` (queue) based on worker status.
- `src/profiles/` + `profiles/*.md` — packaged worker roles (explorer, fixer, reviewer, librarian, observer, oracle, designer). The loader reads the markdown frontmatter; `default-profiles.ts` declares the TS spec. Profile choice drives default tools, thinking level, extension mode, and write policy.
- `src/safety/` — `launch-policy.ts` enforces profile rules at delegation time; `path-scope.ts` validates that write-capable profiles (notably `fixer`) carry an explicit writable `pathScope`. Read-only profiles can inspect broadly; write-capable profiles cannot launch without scoped roots.
- `src/prompts/contracts.ts` + `prompts/orchestrator.md` + `prompts/agents/*.md` — prompt contracts. `buildOrchestratorPromptBundle` is injected into the main session's system prompt on `before_agent_start`. `buildWorkerTaskPrompt` wraps each delegated task.
- `src/ui/` — `status-widget.ts` and `dashboard.ts` render from `PersistedTeamState`; `overlay.ts` drives the `/team` overlay in interactive mode.
- `src/commands/` — slash command registrations (`/team`, `/agents`, `/ping-agents`, `/agent-steer`, `/agent-followup`, `/agent-cancel`, `/agent-result`).

### Key invariants worth preserving

- **Compact state, not transcripts.** Persisted state (`createPersistedStateSnapshot`) stores compact summaries, relay questions, and worker status — never raw streaming deltas or full transcripts. Don't pipe transcripts back into orchestrator context.
- **Terminal status set is canonical.** `isTerminalWorkerStatus` (`idle`, `completed`, `aborted`, `error`, `exited`) gates `wait_for_agents`, terminal toasts, and UI "done" states. `starting` and `running` are non-terminal; `waiting_followup` is non-terminal. When editing state transitions, keep `deriveStatusFromSessionState` and `applyNormalizedEvent` aligned with this set.
- **Workers transition `starting → running` via `promptWorker`.** The pre-prompt `refreshState` returns `isStreaming: false`; `applyNormalizedEvent`'s `worker_state` branch intentionally does **not** demote `"starting"` to `"idle"` — otherwise the state listener spuriously emits "worker finished" toasts before the worker has actually run. See `flushTerminalNotifications` in the extension for the defensive filter that backs this up.
- **Session restore is honest.** `markRestoredWorkersExited` forces restored workers to `exited` on session start. Live RPC processes are not silently reattached. Do not change this — orphaned state is worse than forcing a relaunch.
- **Recursive orchestrator launches are blocked.** Workers launch with `extensionMode: "worker-minimal"` by default, which prevents the full orchestrator package from reinitializing inside a worker.

### Worker state flow

`delegateTask` → `WorkerManager.launchWorker` (spawns process, `refreshState`) → `WorkerManager.promptWorker` (status → `running`). RPC events arrive via `RpcClient.onEvent` → `normalizeRpcEvent` → `applyNormalizedEvent` which mutates `WorkerRuntimeState` and emits snapshot. `TeamManager` subscribes, upserts into `TaskRegistry`, re-emits `state_change`, which drives persistence and UI.

Messaging: `agent_message` with `delivery: "auto"` picks `steer` (for `running`) or `follow_up` (for idle states) via `resolveWorkerMessageDelivery`. `agent_status` is cheap and passive; `ping_agents` with `mode: "active"` refreshes RPC state and stats.

## Conventions

- Strict TypeScript, ESM (`"type": "module"`). Tests use `node:test` + `node:assert/strict`; runtime tests lean on the `MockWorkerTransport` / `MockWorkerHandle` helpers in `tests/runtime/test-helpers.ts` rather than spawning real `pi` processes.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas in the extension entrypoint — keep schemas and the `params` shape passed to `TeamManager` in sync.
- Profile prompt files (`prompts/agents/*.md`) and profile specs (`profiles/*.md`) are tested for existence/shape by `tests/prompts/prompt-files.test.ts` and `tests/profiles/loader.test.ts` — if adding or renaming a profile, both locations must stay aligned.
