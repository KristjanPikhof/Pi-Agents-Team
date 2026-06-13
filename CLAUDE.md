# Agent guide

Pi extension: one visible Pi session is the orchestrator; bounded work runs in background RPC workers via `pi --mode rpc --no-session`. Keep user-facing dialogue in the orchestrator. Keep worker state compact: summary, relay questions, status, usage, and `<final_answer>` only. Never persist raw transcripts, raw activity events, or raw streaming deltas.

## Commands

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # tsx --test tests/**/*.test.ts
npm run check           # typecheck + tests
npm run smoke:runtime   # tsx scripts/smoke/runtime-worker.ts
npm run smoke:team      # tsx scripts/smoke/team-flow.ts
```

Single test: `npx tsx --test tests/runtime/worker-manager.test.ts`. Do not rely on `npm test -- <path>` for targeted runs because the package script already includes the glob. Local load: `pi -e ./extensions/index.ts`. Node `>=22.19.0`. Strict TS, ESM, `node:test` + `node:assert/strict`; no jest/vitest/bun. No lint/build scripts; package ships TS sources and `prepublishOnly` runs `npm run check`.

## Structure

- `extensions/index.ts`: package export; re-exports the extension entry.
- `extensions/pi-agent-team/index.ts`: registers tools, commands, lifecycle/session handlers, widget/overlay wiring.
- `src/control-plane/team-manager.ts`: coordination boundary. Commands/tools go through `TeamManager`, not directly to `WorkerManager`.
- `src/control-plane/task-registry.ts`, `persistence.ts`: compact registry, persisted session state, retained pruned usage.
- `src/runtime/`: RPC launch/process, JSONL events, `WorkerManager`, event normalization, final-answer extraction, assistant/activity buffers.
- `src/ui/`: overlay, widget, dashboard text, copy payloads, terminal sanitizing, width-safe formatting.
- `src/commands/`, `src/comms/`, `src/prompts/`, `src/profiles/`, `src/project-config/`, `src/safety/`: focused subsystems.
- `profiles/*.md` and `prompts/agents/*.md`: parity-tested; rename/update together.
- Deep refs: `docs/architecture.md`, `docs/operations.md`, `docs/profiles.md`, `docs/prompting.md`.

Package surface: `package.json` exports `./extensions/index.ts`; Pi discovers the same path through `pi.extensions`.

## Operator surface

- Commands: `/team`, `/team-steer`, `/team-stop`, `/team-copy`, `/team-result`, `/team-enable`, `/team-init`.
- Tools: `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.
- `/team`: Workers/Inspect/Console/Cost tabs, action bar steer/message/new/close/cancel/prune/refresh/copy/quit, active refresh on open, Console Activity by default with `r` toggling Raw.
- Do not re-add without discussion: `/team-status`, `/agents`, `/ping-agents`, `/team-on`, `/team-off`, `/team-cost`, `/team-prune`, `/team-disable`, `/agent-cancel`, `/agent-close`, `/agent-steer`, `/agent-followup`, `/agent-result`.

## Load-bearing invariants

- Status set is canonical: terminal `idle | completed | aborted | error | exited`; non-terminal `starting | running | waiting_followup`. Keep runtime normalization, `isTerminalWorkerStatus`, UI glyphs, broadcasts, and `wait_for_agents` aligned.
- Starting guard: `worker_state` keeps `starting` when `status === "starting" && !event.state.isStreaming`. Widening breaks running->idle; narrowing revives false finish toasts.
- Rejected prompt acceptance is terminal: `promptWorker` marks `running` before RPC prompt; rejection marks `error`, emits state, and rethrows.
- Terminal workers reject messages. `idle` and `waiting_followup` stay live and accept fresh prompts.
- Delivery union is exactly `"steer" | "follow_up" | "prompt"`. Idle/waiting `/team-steer`, including `--queue`, upgrades to `prompt`; overlay steer/message must not pre-block idle/waiting.
- `wait_for_agents` wakes on `all_terminal | relay_raised | timeout | aborted`; `relay_raised` returns new relay questions since the wait baseline. Prefer wait over polling.
- Relay noise filtering has three layers: `PLACEHOLDER_RELAY_VALUES`, relay toast listener guard, worker prompt wording. Keep all to avoid `needs guidance: none`.
- Summary aliases are intentional: `buildWorkerSummaryFromText` accepts `read_files`/`changed_files` and `files_read`/`files_changed`.
- Close/cancel/prune differ: cancel non-terminal streams/processes; close only idle/waiting RPC handles and uses `closing` so exit maps to `exited`; prune removes terminal registry entries, disposes leftover handles, and folds usage into `prunedWorkerUsageTotals` exactly once. No auto-prune.
- Reuse is launch-strict and context-aware: only idle/waiting, same profile and launch-affecting settings (`model`, tools, cwd, prompt path, extension mode, thinking level, skills, trust/extensions). Refresh stats first; reject `contextPercent >= 80` or `contextRemainingTokens <= 32768`. Unknown/null context is allowed; prefer fresh workers for long exploratory work.
- `closing` is only for operator close/dispose; cancel does not set it.
- Session restore is honest: restored live workers become `exited`; warn on non-startup restore, never reattach old RPC processes.
- Reload gates writes: `session_start` sets `reloading = true` during `replaceTeamManager`; tools and `/team-enable` call `ensureNotReloading()`. Read-only commands skip the guard.
- Broadcasts swallow per-worker errors and return per-worker results.

## Activity, transcripts, and final answers

- `record.textBuffer` is a retained assistant-text tail, capped at 4,000 lines and 256 KiB. Transcript reads add `[transcript truncated: ...]` when older text was dropped.
- Assistant chunks are memory-only, bounded by 4,096 chunks and 256 KiB. Eviction must keep at least one chunk so one oversized delta does not blank Console. Reuse resets chunks, activity, final answer, summary, relays, and `nextIndex`.
- Runtime Activity and overlay fallback must not render streamed final-answer content as process Thinking. Runtime extracts/dedupes final summaries; overlay fallback in `src/ui/overlay.ts#synthesizeActivity` handles split final-answer markers across chunks, including character-by-character streams. Raw diagnostics must still show original chunks.
- Copy payload order is task/summary/relays/usage/final answer/retained latest assistant-text tail/`## Activity`/`## Console timeline (Raw)`. Use the retained-transcript helper so truncation notices survive display caps.

## UI rules

- Widget spinner starts only while animated workers exist, stops on terminal/session shutdown, and `.unref()`s.
- Use pi-tui `visibleWidth`/`truncateToWidth`, not raw `.length`/`.slice`. `sanitizeText` preserves `\x1b` for trusted colors and normalizes tabs; `sanitizeTerminalText` strips hostile worker controls, including CR.
- Overlay row budget must match `TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight = "90%"` and `OVERLAY_HEIGHT_PCT = 0.9`; update `tests/ui/overlay.test.ts` when either changes.
- Console viewport reserves one header row: `renderConsoleBody` uses `rows - 1` for both `maxTop` and slice.
- `/team` `[n]ew` mirrors the `delegate_task` solo guard at modal-open and submit time. It always delegates fresh, never reuses the selected worker.
- Overlay `dispose()` is idempotent and unsubscribes `onAssistantChunk`/activity listeners on `q`/`esc`/host close.
- Active ping is bounded per worker. A timeout returns the latest registry snapshot, persists a warning on the worker snapshot, and must not spawn duplicate stuck refreshes; clear `activeRefreshes` on settle, prune, and dispose.

## Config and launch policy

- Config precedence is by file presence, not validity. Nearest project file `<cwd-ancestor>/.pi/agent/agents-team.json` wins over global `~/.pi/agent/agents-team.json`, even if invalid. Active schema mismatch/fatal parse disables delegation with warnings; non-winning fatal parse is diagnostic-only.
- Freshness toasts inspect only `LoadedTeamProjectConfig.activeConfigFreshness`: project-local wins by presence, then global, then none. Dedup key is active scope + `scaffoldVersion` or `unknown`, stored on `globalThis` via `Symbol.for("pi-agents-team.scaffoldFreshnessToasts")` across Pi `/reload`.
- `schemaVersion` and `scaffoldVersion` live in `src/project-config/versions.ts`. Schema is the parsing contract; scaffold is active-config content freshness.
- Bad `roles.<name>.thinkingLevel` is field-tolerant: drop the field, warn, keep the role. Launch cascade: explicit request -> role default -> live `pi.getThinkingLevel()` -> `medium`; emit clamp toast if Pi returns a different effective level.
- Path scope is a prompt convention, not an OS sandbox. It blocks bad delegations but does not contain bash, network, subprocesses, or a worker that ignores prompts.
- User-controlled prompt strings are length-capped, sanitized, fenced, and wrapped in `<!-- BEGIN available-profiles -->` sentinels.
- Config writes use `src/util/backup.ts#atomicWriteFileSync`; `/team-enable` shallow-merges so roles, `enabled`, `workerAccess`, and `display` survive.
- Team profile names come from active config. Pi skills are separate `delegate_task.skills`; never bake installed skill names into prompts/examples/default roles.
- Cost totals are agents-only: exclude orchestrator cost, include retained `prunedWorkerUsageTotals`, and honor `display.cost` for widget row, Cost tab, and retained/pruned note.
- Routing mode is `TeamManager` state. `/team-enable on|off` without flags is session-only; `--local`, `--global`, and deprecated `--persist local|global` persist it. Do not put routing mode in `PersistedTeamState`.

## Tests and docs

- Run `npm run check` before claiming correctness. For doc-only edits, at least run `git diff --check`; run full check when behavior or tests changed.
- Targeted tests:
  - Runtime/status/RPC/activity: `tests/runtime/worker-manager.test.ts`, `tests/runtime/event-normalizer.test.ts`, `tests/runtime/rpc-client.test.ts`.
  - Control plane/tools/routing/reuse: `tests/control-plane/*.test.ts`, `tests/comms/*.test.ts`.
  - Config/freshness/reload: `tests/project-config/*.test.ts`, `tests/control-plane/project-config-extension.test.ts`.
  - Commands: `tests/commands/*.test.ts`; command registration is asserted in `tests/control-plane/extension-wiring.test.ts`.
  - Overlay/widget/copy/text: `tests/ui/*.test.ts`; strip ANSI with existing helpers and keep visible-width assertions.
  - Prompts/profiles/package: `tests/prompts/*`, `tests/profiles/*`, `tests/package-manifest.test.ts`.
- Operator-facing changes (commands, dashboard, overlay/widget behavior, tool params, delivery, copy payloads) require `README.md` and `docs/operations.md` updates.
- Runtime architecture/state changes usually require `docs/architecture.md`. Config behavior changes usually require `docs/profiles.md`, `docs/architecture.md`, and loader/extension tests.
- Contract changes (worker final answer, responsibilities, wait semantics) require `docs/prompting.md` and/or `prompts/orchestrator.md` / `prompts/agents/*.md`.
- Package version bumps must update `package.json` and `package-lock.json` together, usually with `npm version <patch|minor|major> --no-git-tag-version` unless the user wants a git tag.

## Anti-patterns

- Do not persist transcripts, raw deltas, raw activity events, or tool dumps.
- Do not bypass `TeamManager` from commands/tools.
- Do not emit toasts as conversation; terminal/relay toasts are UI-only.
- Do not auto-prune terminal workers.
- Do not add orchestrator tokens to `Σ` cost.
- Do not leave backward-compat shims, unused re-exports, unused constants, or `_var` stubs.
- Do not add emojis unless asked.
- Do not strip ESC from trusted styling paths.
- Do not pre-block idle/waiting workers in overlay steer/message paths.
- Do not document internal tolerance, such as relaxed final-answer tag variants, as a public prompt contract unless explicitly intended.

## Before sensitive changes

- Status/toasts/runtime: re-read `src/runtime/worker-manager.ts`, `src/runtime/event-normalizer.ts`, `src/control-plane/team-manager.ts`, `docs/architecture.md`, and relevant tests.
- Pi reload/session lifecycle: `/reload` tears down the old extension runtime, disables jiti cache, re-runs factories, then emits `session_start reason=reload`; use process/global storage only for intentional cross-reload state and clean external resources on `session_shutdown`.
- Config/scaffold: read `src/project-config/loader.ts`, `src/project-config/versions.ts`, `docs/profiles.md`, and freshness tests.
- UI: read `src/ui/theme.ts`, `src/ui/overlay.ts`, `src/ui/status-widget.ts`, overlay/widget tests, and pi-tui width rules.
- New command/tool: first check whether `/team` or existing tools cover it; update wiring tests and docs if added.

## Doc map

| File | Covers |
|---|---|
| `README.md` | overview, install, command table |
| `CONTRIBUTING.md` | setup, test discipline, package layout |
| `docs/architecture.md` | layering, runtime flow, state, toasts, widget/overlay, routing |
| `docs/operations.md` | dashboard keys, copy, steer/followup, routing toggle, troubleshooting |
| `docs/profiles.md` | default roles, schema, prompt resolution, config precedence, version bumps |
| `docs/prompting.md` | orchestrator/worker contracts, final-answer contract, wait-don't-poll |
| `prompts/orchestrator.md` | orchestrator contract injected on `before_agent_start` |
| `prompts/agents/*.md` | per-role worker contracts |
