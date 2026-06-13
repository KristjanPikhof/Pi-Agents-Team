# Agent guide

Pi extension. One visible Pi session acts as orchestrator; bounded work runs in background RPC workers via `pi --mode rpc --no-session`. Keep user-facing dialogue in the orchestrator. Keep worker state compact: summary, relay questions, status, usage, and `<final_answer>` only. Do not persist raw transcripts/events.

## Commands

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # tsx --test tests/**/*.test.ts
npm run check           # typecheck + test
npm run smoke:runtime   # tsx scripts/smoke/runtime-worker.ts
npm run smoke:team      # tsx scripts/smoke/team-flow.ts
```

Single test: `tsx --test tests/runtime/worker-manager.test.ts`. Local load: `pi -e ./extensions/index.ts`. Node >=20. Strict TypeScript, ESM, `node:test` + `node:assert/strict`; no jest/vitest/bun.

## Structure

- `extensions/index.ts` re-exports the extension entry.
- `extensions/pi-agent-team/index.ts` registers tools, commands, session handlers, UI wiring.
- `src/control-plane/team-manager.ts` is the coordination boundary; commands/tools go through it, never directly to `WorkerManager`.
- `src/runtime/` owns RPC process launch, JSONL events, `WorkerManager`, assistant ring buffer.
- `src/comms/`, `src/prompts/`, `src/profiles/`, `src/safety/`, `src/ui/`, `src/commands/` hold focused subsystems.
- `profiles/*.md` and `prompts/agents/*.md` are parity-tested; rename/update together.
- `docs/architecture.md`, `docs/operations.md`, `docs/profiles.md`, `docs/prompting.md` are the deep references.

Package surface: `package.json` exports `./extensions/index.ts`; Pi discovers the same path via `pi.extensions`.

## Operator surface

- Commands: `/team`, `/team-steer`, `/team-stop`, `/team-copy`, `/team-result`, `/team-enable`, `/team-init`.
- Tools: `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.
- `/team` overlay: Workers/Inspect/Console/Cost tabs; action bar steer/message/new/close/cancel/prune/refresh/copy/quit; Console live-tails `getAssistantTail` + `onAssistantChunk`; idle/waiting rows show `[reuse]`.
- Do not re-add without discussion: `/team-status`, `/agents`, `/ping-agents`, `/team-on`, `/team-off`, `/team-cost`, `/team-prune`, `/team-disable`, `/agent-cancel`, `/agent-close`, `/agent-steer`, `/agent-followup`, `/agent-result`.

## Load-bearing invariants

- Status set is canonical: terminal = `idle | completed | aborted | error | exited`; non-terminal = `starting | running | waiting_followup`. Keep `deriveStatusFromSessionState`, `applyNormalizedEvent`, `isTerminalWorkerStatus`, UI glyphs, broadcasts, and `wait_for_agents` aligned.
- Starting race guard: `WorkerManager.launchWorker` refreshes state before prompt; `worker_state` must keep `starting` when `status === "starting" && !event.state.isStreaming`. Widening breaks running->idle; narrowing revives false finish toasts.
- Rejected prompt acceptance is terminal: `promptWorker` marks `running` before RPC prompt; rejection must mark `error`, emit state, and rethrow.
- Terminal workers reject messages: `completed | aborted | error | exited` are unreachable. `idle` and `waiting_followup` remain live and accept fresh prompts.
- Delivery is a 3-way union: `"steer" | "follow_up" | "prompt"`. On idle/waiting, `/team-steer` (even `--queue`) upgrades to `prompt`; overlay steer/message must not pre-block idle/waiting.
- `wait_for_agents` wakes on relays: `all_terminal | relay_raised | timeout | aborted`; `relay_raised` returns new relay questions since the wait baseline. Prefer wait over polling.
- Placeholder relay filtering has 3 layers: parser (`PLACEHOLDER_RELAY_VALUES`), relay toast listener, worker prompt wording. Keep all to avoid `needs guidance: none` noise.
- Summary aliases are intentional: `buildWorkerSummaryFromText` accepts `read_files`/`changed_files` and `files_read`/`files_changed`.
- Assistant chunks are bounded in memory only; never persist transcripts. Reuse resets chunks/final answer/summary/relay state. Eviction must keep at least one chunk so a single oversized delta does not blank Console.
- Close/cancel/prune differ: cancel non-terminal streams/processes; close only idle/waiting RPC handles and uses `closing` so exit maps to `exited`; prune removes terminal registry entries and disposes leftover live handles, folding each removed worker's usage into `prunedWorkerUsageTotals` exactly once via `TaskRegistry.removeWorker` before delete. No auto-prune.
- Reuse is launch-strict: only idle/waiting, same profile and launch-affecting settings (`model`, tools, cwd, prompt path, extension mode, thinking level, skills). Cross-profile or changed launch fields reject.
- Reuse is context-aware after launch checks: refresh stats before registering/prompting reuse; reject `contextPercent >= 80` or `contextRemainingTokens <= 32768`; unknown/null context is allowed but prompt guidance should prefer fresh workers for long or multi-lane work. Do not add auto-compact as the fix.
- `closing` flag is only for operator close/dispose; cancel does not set it.
- Widget spinner timer starts only while animated workers exist, stops on terminal/session shutdown, and `.unref()`s.
- TUI width is ANSI-aware. Use pi-tui `visibleWidth`/`truncateToWidth`, not raw `.length`/`.slice`. `sanitizeText` must preserve `\x1b` for colors and normalize tabs.
- Overlay row budget must match `TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight = "90%"` and `OVERLAY_HEIGHT_PCT = 0.9`; update `tests/ui/overlay.test.ts` if either changes.
- Console viewport reserves one header row: `renderConsoleBody` uses `rows - 1` for both `maxTop` and slice.
- `/team` `[n]ew` mirrors `delegate_task` solo guard at modal-open and submit time; `[n]ew` always delegates fresh, never reuses selected worker.
- Overlay `dispose()` is idempotent and must unsubscribe `onAssistantChunk` on `q`/`esc`/host close.
- Session restore is honest: restored workers become `exited`; warn on non-startup restore, never silently reattach old RPC processes.
- Reload gates writes: `session_start` sets `reloading = true` during `replaceTeamManager`; tool `execute` and `/team-enable` call `ensureNotReloading()`. Read-only commands skip this guard.
- Broadcasts swallow per-worker errors and return per-worker results.

## Config and launch policy

- Config precedence is by file presence, not validity. Project file at `<cwd-ancestor>/.pi/agent/agents-team.json` wins over global `~/.pi/agent/agents-team.json` even if invalid. Schema mismatch/fatal active config follows warning/disabled-delegation paths; non-winning fatal parse is diagnostic-only. See `docs/profiles.md`.
- Freshness toasts inspect only `LoadedTeamProjectConfig.activeConfigFreshness`: project-local wins by presence, otherwise global, otherwise none. Stale non-winning layers do not toast. Missing active `scaffoldVersion` is a soft `unknown` warning; schema mismatch/fatal parse stays separate.
- Freshness dedup is per Pi process by active scope + `scaffoldVersion` or `unknown`, stored via `Symbol.for("pi-agents-team.scaffoldFreshnessToasts")` on `globalThis` so it survives real Pi `/reload` factory re-instantiation. Tests reset this process-global Set and simulate two factory instances in `tests/control-plane/project-config-extension.test.ts`.
- `schemaVersion` and `scaffoldVersion` live in `src/project-config/versions.ts`. Schema is the parsing contract; scaffold is active-config content freshness only.
- Bad `roles.<name>.thinkingLevel` is field-tolerant: drop that field, warn, keep the role. Launch cascade: explicit role/request -> built-in role default -> live `pi.getThinkingLevel()` -> `medium`; worker records requested/effective and emits clamp toast if Pi clamps.
- Path scope is prompt convention, not an OS sandbox. It blocks bad delegation combinations but does not contain bash, network, subprocesses, or a worker that ignores its prompt.
- User-controlled prompt strings are length-capped, sanitized, fenced, and wrapped in `<!-- BEGIN available-profiles -->` sentinels.
- Config writes are atomic via `src/util/backup.ts#atomicWriteFileSync`; `/team-enable` shallow-merges so roles/`enabled`/`workerAccess`/`display` survive.
- Team profile names come from active config; Pi skills are separate `delegate_task.skills`. Never bake installed skill names into prompts/examples/default roles.
- Cost totals are agents only: `aggregateUsage()` and widget `Σ` exclude orchestrator cost but include `prunedWorkerUsageTotals` retained from pruned terminal workers, so totals survive across prune. Cost tab shows a `retained/pruned` note when retained usage is non-zero; widget can render Σ-only after all rows are pruned. `display.cost` gates widget row, Cost tab, and the retained/pruned note, default true.
- Routing mode is control-plane state, not persisted worker state. `TeamManager.routingMode` gates `delegate_task`; `/team-enable on|off` without flags changes only the live session, while `--local`/`--global` (or deprecated `--persist local|global`) explicitly persist `routingMode`. Do not put routing mode in `PersistedTeamState`.

## Tests and validation

- Run `npm run check` before claiming correctness.
- Target likely tests:
  - Runtime/status/RPC: `tests/runtime/worker-manager.test.ts`, `tests/runtime/event-normalizer.test.ts`.
  - Control plane/tools/routing/reuse: `tests/control-plane/*.test.ts`.
  - Config/freshness/reload: `tests/project-config/loader.test.ts`, `tests/control-plane/project-config-extension.test.ts`.
  - Commands: `tests/commands/*.test.ts`; command list is asserted in `tests/control-plane/extension-wiring.test.ts`.
  - Overlay/widget: `tests/ui/*.test.ts`; strip ANSI with `stripAnsi`/render helpers.
  - Prompts/profiles parity: `tests/prompts/*`, `tests/profiles/*`.
- Operator-facing changes (commands, dashboard, tool params, delivery) require `README.md` + `docs/operations.md` updates.
- Contract changes (worker final answer, responsibilities, wait semantics) require `prompts/orchestrator.md` or `prompts/agents/*.md` updates.
- Config behavior changes usually require `docs/profiles.md`, `docs/architecture.md`, and loader/extension tests.
- Overlay layout changes must keep maxHeight/row-budget tests in sync.

## Anti-patterns

- Do not persist transcripts or raw events.
- Do not bypass `TeamManager` from commands/tools.
- Do not emit toasts as conversation; terminal/relay toasts are UI-only.
- Do not auto-prune terminal workers.
- Do not add orchestrator tokens to `Σ` cost.
- Do not leave backward-compat shims, unused re-exports, or `_var` stubs.
- Do not add emojis unless asked.
- Do not widen `sanitizeText` to strip ESC (`\x1b`).
- Do not pre-block idle/waiting workers in overlay steer/message paths.

## Before changing sensitive areas

- State transitions/status/toasts: re-read `src/runtime/worker-manager.ts`, `src/control-plane/team-manager.ts`, `docs/architecture.md`, and relevant tests.
- Pi reload/session lifecycle: Pi `/reload` tears down old extension runtime, reloads modules with jiti cache disabled, re-runs factories, then emits `session_start reason=reload`; use process/global storage only for intentional cross-reload state and clean external resources on `session_shutdown`.
- Config loader/scaffold: read `src/project-config/loader.ts`, `src/project-config/versions.ts`, `docs/profiles.md`, and freshness tests.
- UI: read `src/ui/theme.ts`, overlay/widget tests, and pi-tui width rules.
- New command/tool: first check whether `/team` or existing tools cover it; update wiring tests and docs if added.

## Doc map

| File | Covers |
|---|---|
| `README.md` | overview, install, command table |
| `CONTRIBUTING.md` | setup, test discipline, package layout |
| `docs/architecture.md` | layering, runtime flow, state, toasts, widget/overlay, routing |
| `docs/operations.md` | dashboard keys, copy, steer/followup, routing toggle, troubleshooting |
| `docs/profiles.md` | default roles, schema, prompt resolution, config precedence, version bumps |
| `docs/prompting.md` | orchestrator/worker contracts, `<final_answer>`, wait-don't-poll |
| `prompts/orchestrator.md` | orchestrator contract injected on `before_agent_start` |
| `prompts/agents/*.md` | per-role worker contracts |
| `tests/control-plane/project-config-extension.test.ts` | session_start notices, active freshness, reload dedup |
