# Agent guide

Pi extension. Visible session = orchestrator; background workers run through `pi --mode rpc --no-session`. Keep user-facing dialogue in the orchestrator. Worker state stays compact: summary, relay questions, status, usage, `<final_answer>`. Never persist raw transcripts/events/deltas/tool dumps.

## Commands

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # tsx --test tests/**/*.test.ts
npm run check           # typecheck + tests
npm run smoke:runtime   # tsx scripts/smoke/runtime-worker.ts
npm run smoke:team      # tsx scripts/smoke/team-flow.ts
```

Single test: `npx tsx --test tests/runtime/worker-manager.test.ts`. Do not use `npm test -- <path>` for targeting, the script already includes the glob. Local load: `pi -e ./extensions/index.ts`. Node `>=22.19.0`. Strict TS, ESM, `node:test` + `node:assert/strict`; no jest/vitest/bun. No lint/build scripts. Package ships TS; `prepublishOnly` runs `npm run check`.

## Project map

| Path | Purpose |
|---|---|
| `extensions/index.ts` | package export |
| `extensions/pi-agent-team/index.ts` | tools, commands, lifecycle, widget/overlay wiring |
| `src/control-plane/team-manager.ts` | coordination boundary; commands/tools go here, not to `WorkerManager` |
| `src/control-plane/task-registry.ts`, `persistence.ts` | compact registry, persisted state, retained pruned usage |
| `src/runtime/` | RPC launch/process, JSONL events, `WorkerManager`, event normalization, final-answer extraction, buffers |
| `src/ui/` | overlay, widget, dashboard text, copy payloads, terminal sanitizing, width-safe formatting |
| `src/commands/`, `src/comms/`, `src/prompts/`, `src/profiles/`, `src/project-config/`, `src/safety/` | focused subsystems |
| `docs/architecture.md`, `docs/operations.md`, `docs/profiles.md`, `docs/prompting.md` | deep references |

`profiles/*.md` and `prompts/agents/*.md` are parity-tested; rename/update together. `package.json` exports `./extensions/index.ts`; Pi discovers the same path via `pi.extensions`.

## Operator surface

Commands: `/team`, `/team-steer`, `/team-stop`, `/team-copy`, `/team-result`, `/team-enable`, `/team-init`.
Tools: `delegate_task`, `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, `agent_cancel`.
`/team`: Workers/Inspect/Console/Cost tabs; active refresh on open; Console shows Activity by default, `r` toggles Raw there and refreshes elsewhere.
Do not re-add without discussion: `/team-status`, `/agents`, `/ping-agents`, `/team-on`, `/team-off`, `/team-cost`, `/team-prune`, `/team-disable`, `/agent-cancel`, `/agent-close`, `/agent-steer`, `/agent-followup`, `/agent-result`.

## Load-bearing invariants

- Status set: terminal `idle | completed | aborted | error | exited`; non-terminal `starting | running | waiting_followup`. Keep normalizer, `isTerminalWorkerStatus`, UI glyphs, broadcasts, and `wait_for_agents` aligned.
- Starting guard: keep `starting` when `worker_state.status === "starting" && !state.isStreaming`. Widening breaks running->idle; narrowing revives false finish toasts.
- Prompt rejection: `promptWorker` marks `running` before RPC prompt; rejection marks `error`, emits state, rethrows.
- Terminal workers reject messages; `idle`/`waiting_followup` accept fresh prompts.
- Delivery union: `"steer" | "follow_up" | "prompt"`. Idle/waiting `/team-steer`, even `--queue`, upgrades to `prompt`; overlay steer/message must not pre-block idle/waiting.
- `wait_for_agents`: `all_terminal | relay_raised | timeout | aborted`; prefer wait over polling. `relay_raised` returns new relay questions since the baseline.
- Relay placeholder filtering needs all layers: `PLACEHOLDER_RELAY_VALUES`, relay-toast guard, worker prompt wording.
- `buildWorkerSummaryFromText` intentionally accepts `read_files`/`changed_files` and `files_read`/`files_changed`.
- Close/cancel/prune: cancel non-terminal streams/processes; close idle/waiting RPC handles and maps exit to `exited`; prune removes terminal registry entries, disposes leftover handles, and folds usage into `prunedWorkerUsageTotals` once. No auto-prune.
- Reuse: only idle/waiting, same profile and launch-affecting settings (`model`, tools, cwd, prompt path, extension mode, thinking level, skills, trust/extensions). Refresh stats first; reject `contextPercent >= 80` or `contextRemainingTokens <= 32768`. Unknown context is allowed; prefer fresh for long exploration.
- Restore/reload: restored live workers become `exited`; never reattach old RPC processes. `session_start` sets `reloading = true` during `replaceTeamManager`; tools and `/team-enable` call `ensureNotReloading()`.
- Broadcasts swallow per-worker errors and return per-worker results.

## Activity, transcripts, UI

- `record.textBuffer` is retained assistant-text tail, capped at 4,000 lines/256 KiB. Transcript reads add `[transcript truncated: ...]` when older text dropped.
- Assistant chunks are memory-only, capped at 4,096 chunks/256 KiB. Keep at least one chunk on eviction. Reuse resets chunks, activity, final answer, summary, relays, `nextIndex`.
- Final-answer text must not render as process Thinking. Runtime extracts/dedupes final summaries; overlay fallback `synthesizeActivity` handles split final-answer markers across chunks, including char-by-char streams. Raw mode keeps original chunks.
- Copy payload order: task/summary/relays/usage/final answer/retained latest assistant-text tail/`## Activity`/`## Console timeline (Raw)`. Use retained-transcript helper so truncation notices survive display caps.
- Use pi-tui `visibleWidth`/`truncateToWidth`, not `.length`/`.slice`. `sanitizeText` preserves `\x1b` for trusted colors; `sanitizeTerminalText` strips hostile worker controls, including CR.
- Overlay row budget: `TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight = "90%"` must match `OVERLAY_HEIGHT_PCT = 0.9`; update `tests/ui/overlay.test.ts` if changed.
- Console viewport reserves one header row: `renderConsoleBody` uses `rows - 1` for `maxTop` and slice.
- Widget spinner starts only while animated workers exist, stops on terminal/session shutdown, and `.unref()`s.
- `/team` `[n]ew` checks solo mode at modal-open and submit; always delegates fresh, never reuses selected worker.
- Overlay `dispose()` is idempotent and unsubscribes chunk/activity listeners on `q`/`esc`/host close.
- Active ping is bounded per worker. Timeout returns latest registry snapshot, persists a worker warning, and must not spawn duplicate stuck refreshes. Clear `activeRefreshes` on settle, prune, dispose.

## Config and launch

- Config precedence is file presence, not validity. Nearest project `.pi/agent/agents-team.json` beats global `~/.pi/agent/agents-team.json`, even invalid. Active invalid config disables delegation with warnings; non-winning fatal parse is diagnostic-only.
- Freshness toasts inspect only `LoadedTeamProjectConfig.activeConfigFreshness`: project-local, then global, then none. Dedup key = active scope + `scaffoldVersion` or `unknown`, stored on `globalThis` via `Symbol.for("pi-agents-team.scaffoldFreshnessToasts")` across `/reload`.
- `schemaVersion` and `scaffoldVersion`: `src/project-config/versions.ts`. Schema = parsing contract; scaffold = active-config content freshness.
- Bad `roles.<name>.thinkingLevel`: drop field, warn, keep role. Launch cascade: explicit request -> role default -> live `pi.getThinkingLevel()` -> `medium`; emit clamp toast if Pi returns different effective level.
- Path scope is prompt convention, not OS sandbox. It blocks bad delegations but does not contain bash/network/subprocesses/worker behavior.
- User-controlled prompt strings are length-capped, sanitized, fenced, and wrapped in `<!-- BEGIN available-profiles -->` sentinels.
- Config writes use `src/util/backup.ts#atomicWriteFileSync`; `/team-enable` shallow-merges roles, `enabled`, `workerAccess`, `display`.
- Team profile names come from active config. Pi skills are separate `delegate_task.skills`; never bake installed skill names into prompts/examples/default roles.
- Cost totals are agents-only: exclude orchestrator cost, include retained `prunedWorkerUsageTotals`, honor `display.cost`.
- Routing mode is `TeamManager` state. `/team-enable on|off` without flags is session-only; `--local`, `--global`, deprecated `--persist local|global` persist it. Do not put routing mode in `PersistedTeamState`.

## Tests and docs

- Run `npm run check` before claiming code correctness. For doc-only edits, at least run `git diff --check`; run full check when behavior/tests changed.
- Target tests: runtime `tests/runtime/*`; control/comms `tests/control-plane/*`, `tests/comms/*`; config `tests/project-config/*`; commands `tests/commands/*`; UI/copy/widget `tests/ui/*`; prompts/profiles/package `tests/prompts/*`, `tests/profiles/*`, `tests/package-manifest.test.ts`.
- Command registration is asserted in `tests/control-plane/extension-wiring.test.ts`.
- Operator-facing changes require `README.md` and `docs/operations.md`: commands, dashboard, overlay/widget behavior, tool params, delivery, copy payloads.
- Runtime state/architecture changes usually require `docs/architecture.md`. Config changes usually require `docs/profiles.md`, `docs/architecture.md`, loader/extension tests.
- Worker contract changes require `docs/prompting.md` and/or `prompts/orchestrator.md` / `prompts/agents/*.md`.
- Version bumps update `package.json` and `package-lock.json` together, usually `npm version <patch|minor|major> --no-git-tag-version` unless a git tag is requested.

## Anti-patterns

- Do not persist transcripts, raw deltas, raw activity events, or tool dumps.
- Do not bypass `TeamManager` from commands/tools.
- Do not emit toasts as conversation; terminal/relay toasts are UI-only.
- Do not auto-prune terminal workers.
- Do not add orchestrator tokens to `Σ` cost.
- Do not leave backward-compat shims, unused re-exports/constants, or `_var` stubs.
- Do not add emojis unless asked.
- Do not strip ESC from trusted styling paths.
- Do not pre-block idle/waiting workers in overlay steer/message paths.
- Do not document internal tolerance, such as relaxed final-answer tag variants, as public prompt contract unless intended.

## Before sensitive changes

- Status/toasts/runtime: read `src/runtime/worker-manager.ts`, `src/runtime/event-normalizer.ts`, `src/control-plane/team-manager.ts`, `docs/architecture.md`, tests.
- Reload lifecycle: `/reload` tears down old extension runtime, disables jiti cache, re-runs factories, then emits `session_start reason=reload`; use process/global storage only intentionally and clean external resources on `session_shutdown`.
- Config/scaffold: read `src/project-config/loader.ts`, `src/project-config/versions.ts`, `docs/profiles.md`, freshness tests.
- UI: read `src/ui/theme.ts`, `src/ui/overlay.ts`, `src/ui/status-widget.ts`, overlay/widget tests, pi-tui width rules.
- New command/tool: first check whether `/team` or existing tools cover it; update wiring tests and docs if added.
