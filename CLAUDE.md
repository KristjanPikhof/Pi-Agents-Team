# Agent

This file provides guidance to agents when working with code in this repository.

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

Current test count is 98. If a change reduces that without a corresponding deletion, something regressed.

## Architecture

Layering, top to bottom:

- `extensions/pi-agent-team/index.ts` — extension entrypoint. Registers 7 tools, 11 slash commands, lifecycle hooks, the state-change listener that drives UI + notifications + spinner animation, and the terminal-toast batcher.
- `src/control-plane/team-manager.ts` — `TeamManager` is the single coordination boundary. Owns a `TaskRegistry` and a `WorkerManager`. Public shape: `delegateTask`, `messageWorker` / `messageAllWorkers`, `cancelWorker` / `cancelAllWorkers`, `pingWorkers`, `waitForTerminal`, `getWorkerResult`, `getWorkerTranscript`, `getWorkerConsole`.
- `src/runtime/` — RPC transport. `worker-process.ts` spawns the Pi rpc process, `rpc-client.ts` wraps the line-delimited JSON protocol, `event-normalizer.ts` collapses raw RPC events into a stable `NormalizedWorkerEvent` union, `worker-manager.ts` applies those events to `WorkerRuntimeState` and emits snapshots.
- `src/comms/` — message shaping. `summary.ts` parses the worker's structured summary, `relay-queue.ts` extracts `relay_question` + `assumption`, `agent-messaging.ts` picks `steer` vs `follow_up` based on status, `ping.ts` builds passive snapshots.
- `src/profiles/` + `profiles/*.md` — packaged roles (explorer, fixer, reviewer, librarian, observer, oracle, designer). Loader reads markdown frontmatter; `default-profiles.ts` has the TS specs.
- `src/safety/` — `launch-policy.ts` gates every `delegate_task` (extension mode, path scope, recursion block); `path-scope.ts` requires explicit writable roots for scoped-write profiles (today only `fixer`).
- `src/prompts/contracts.ts` — builds the orchestrator system-prompt bundle and the per-task worker prompt. `buildWorkerTaskPrompt` injects the `<final_answer>` contract and, when `task.skills` is non-empty, an explicit "invoke these Pi skills via the Skill tool" block.
- `src/ui/` — `status-widget.ts` (always-visible widget with spinner + counts + per-worker lines), `overlay.ts` (interactive `/team` dashboard with Summary/Console tabs), `dashboard.ts` (print-mode fallback text), `copy-payload.ts` (shared copy-to-clipboard formatter).
- `src/util/clipboard.ts` — platform-aware clipboard (pbcopy / clip.exe / wl-copy / xclip / xsel).
- `src/commands/` — `team.ts`, `steer.ts`, `cancel.ts`, `copy.ts`. Every command delegates to `TeamManager`; they never hit `WorkerManager` directly.

## Operator surface (post-cleanup)

**Slash commands — 11 total.**

- `/team` → opens the dashboard overlay (live RPC ping on open). `y` inside the overlay copies the focused worker to clipboard.
- `/team <worker-id>` → jumps straight into that worker's detail view.
- `/team-copy <worker-id>` → same copy payload as `y`, without opening the overlay.
- `/team-prune` → removes every terminal worker from the dashboard. Use after a cancelled batch.
- `/team-cost` → per-worker token usage plus `Σ` totals. Orchestrator cost stays in Pi's footer.
- `/team-init global|local [--force]` → scaffolds a full `agents-team.json` to `~/.pi/agent/` or `./.pi/agent/` with every builtin role pre-populated and a `defaultsVersion` marker. Refuses to overwrite without `--force`; on `--force` the previous file is renamed to `YYYY-MM-DD-HHMM-agents-team.json` in the same directory before the new scaffold is written. The loader flags layers whose `defaultsVersion` differs from the plugin's `CURRENT_DEFAULTS_VERSION` via `layer.defaultsStale`, and the session_start hook emits a per-layer warning toast telling the operator to re-run `/team-init` (and mentioning the backup).
- `/team-enable global|local` → sets `enabled: true` in the scoped config file (creating it if missing). Run `/reload` to apply.
- `/team-disable global|local` → sets `enabled: false` in the scoped config file. The extension stays loaded but skips tool execution, prompt injection, and UI rendering until re-enabled.
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

**Placeholder relay filter.** Workers sometimes emit `relay_question: none` (or `n/a`, `-`, `null`, etc.) when they have nothing to ask. `extractRelayQuestions` (`src/comms/summary.ts`) drops values matching `PLACEHOLDER_RELAY_VALUES` after case-folding and trimming trailing punctuation. The extension's relay-toast listener additionally refuses to fire for empty/whitespace-only questions. The worker task prompt (`buildWorkerTaskPrompt`) tells models to omit the field entirely. All three layers exist because models drift — removing any one reintroduces the "needs guidance: none" noise.

**The `starting → idle` race guard.** `WorkerManager.launchWorker` calls `refreshState` before `promptWorker`. At that instant the RPC session reports `isStreaming: false`, which naively maps to `idle` (terminal). The `worker_state` branch in `applyNormalizedEvent` keeps a `starting` worker as `starting` while `isStreaming` is false. `flushTerminalNotifications` in the extension filters queued toast entries against current status. Both pieces are load-bearing — touching either without updating the other reintroduces spurious "worker finished" toasts.

**The `<final_answer>` contract.** Every delegated task prompt requires the worker's final assistant message to wrap the deliverable in a single `<final_answer>…</final_answer>` block. `extractFinalAnswer` pulls it into `WorkerRuntimeState.finalAnswer`. If the block is empty, the orchestrator's job is to re-delegate / steer / cancel — not to run investigation tools directly.

**Non-recursive workers.** Default `extensionMode` is `worker-minimal`. `config.safety.preventRecursiveOrchestrator` is `true` and `launch-policy.ts` hard-rejects `extensionMode: "inherit"` so workers never boot the orchestrator package recursively.

**Session restore is honest.** `markRestoredWorkersExited` forces every restored worker to `exited` on session start and returns `{ state, markedCount }`. Do not try to reattach live RPC processes silently — orphaned state is worse than forcing a relaunch. The session-start handler threads Pi's `SessionStartEvent.reason` through so the error message on each flipped worker reflects the real cause (`resume`, `fork`, `reload`, `new`). When the session did not come from a cold `startup` and at least one worker was flipped, the handler emits a single `warning` toast — operators should never be surprised that prior workers went away. Keep that toast *one line* and decorative (not conversational); the orchestrator prompt still tells the LLM to ignore UI notifications.

**Reload swap gates tool execution.** The extension entrypoint keeps a `reloading: boolean` flag. `session_start` sets it `true` before `replaceTeamManager` (which awaits `dispose()` on the old manager and swaps in a new one) and `false` in `finally`. Every tool `execute` calls `ensureNotReloading()` at the top and throws `"Pi Agents Team is reloading its project config — retry in a moment."` during the window. Pre-fix, an in-flight `wait_for_agents` / `delegate_task` / `agent_message` tool call could land on a disposed `TeamManager` mid-reload and surface a confusing low-level error. The `/team-prune`, `/team-cost`, `/agent-result`, and similar operator-facing commands don't need this guard — they only read state, never hit the worker-manager.

**Scaffold-stale toasts are per-process de-duped.** The entrypoint keeps a `Map<scope, scaffoldVersion>` and only emits the "your scaffold is stale, run /team-init --force" toast when `(scope, scaffoldVersion)` hasn't been warned about this process lifetime. Pi fires `session_start` on startup, reload, new, resume, and fork — without de-dup, a dev iterating with `/reload` would see the warning per scope per reload.

**Broadcasts swallow per-worker errors.** `messageAllWorkers` and `cancelAllWorkers` collect failures into the returned result array (setting `error`) rather than throwing. One bad worker must never abort the whole broadcast. Preserve this when extending.

**Delivery resolution is explicit.** `messageWorker` returns `AgentMessageResult` with the resolved `delivery` field (`"steer" | "follow_up" | "prompt"`). `"steer"` / `"follow_up"` only apply when the worker is actively streaming; on idle/waiting_followup workers both `/agent-steer` and `/agent-followup` upgrade to `"prompt"` (fresh RPC `prompt` call that wakes the session), because a bare `follow_up` RPC against an idle session just queues without starting a new turn. UI and commands use the resolved field to tell the user which channel the message actually went down (`Steered w1 (:running)` / `Queued follow-up for w1 (:running)` / `Prompted w1 (:idle)`). Don't drop the `"prompt"` case — reverting to a two-value union reintroduces the "queued but nothing happens" bug.

**Terminal workers reject messages.** `messageWorker` throws a clear `"Worker X is <status> — its RPC session is already disposed"` error when `worker.status` is in `UNREACHABLE_STATUSES` (`completed | aborted | error | exited`). Pre-fix, terminal workers landed on the `delivery: "prompt"` branch because `resolveWorkerMessageDelivery` only special-cases `"running"`; `promptWorker` then briefly flipped the dashboard back to `running` before the disposed RPC client threw a low-level error. `idle` and `waiting_followup` are NOT in this set — they are terminal for UI purposes but the client is still alive and legitimately accepts new prompts. `messageAllWorkers` already filters targets to `["running", "idle", "waiting_followup"]` so broadcast paths never hit this guard.

**Widget spinner timer.** A 120 ms `setInterval` animates the widget while `hasAnimatedWorkers(state)` is true. It starts on state change, stops on the last worker going terminal, stops on `session_shutdown`, and calls `.unref()` so it never blocks process exit. If you change the tick cadence or the animation condition, stop the old timer.

**Widget hides itself when empty.** `buildTeamWidgetLines` returns `[]` if no workers are tracked, and `applyUi` calls `setWidget(key, undefined)` to clear the surface. Do not add empty-state prose — the title bar still identifies the extension via `titleTemplate`. Three lines of "no workers tracked" is what the widget used to do; that was noise.

**Widget layout switches at 6.** ≤ 6 workers → single column (cap 8 visible). > 6 workers → two columns (cap 16 visible, 8 rows × 2). Per-worker cell is truncated to `COLUMN_WIDTH=38`. The whole widget is capped at `HEADER_WIDTH=78`. Spillover shows as `  +N more · /team to view`.

**Visible-width everywhere in TUI code.** Both widget and overlay use pi-tui's `visibleWidth` / `truncateToWidth` — never raw `.length` or `.slice` — because braille spinner glyphs, emoji, and combining chars miscount under code-unit length and crash pi-tui's render validator (`Rendered line N exceeds terminal width`). `wrapLines` in the overlay uses `visibleWidth` for the comparison and `truncateToWidth(remaining, width, "")` for the slice. Every `return` in the overlay's `render` passes through `enforceWidth(lines, width)` as a final safeguard.

**Overlay footer is pinned at the top.** Under the tabs, not the bottom. This is intentional — terminals can clip the overlay and a bottom footer would disappear. A transient `» …` status line shows copy/refresh outcomes for ~2.5s.

**Autocomplete early-returns on whitespace.** Every `getArgumentCompletions(prefix)` must check `if (/\s/.test(prefix)) return [];` before suggesting anything. Without it, the dropdown keeps matching the first token while the user types the rest of the message, and `enter` picks the suggestion instead of submitting the command. This was a real user-reported bug — the reason every command-file touches `prefix` uniformly now. The pattern also enforces "single-argument commands never auto-complete after the first token," which matches operator intent.

**Unknown-target errors use the did-you-mean helper.** When `resolveWorkerId` fails (or the user misspells `all` as `aal`), commands build a candidate pool (`["all", ...listWorkers().map(w.workerId)]` for message/cancel commands, just worker ids for team/copy/result) and pass it to `formatUnknownWorker(input, suggestTargets(input, candidates))`. The helper lives in `src/util/suggest.ts` and uses Levenshtein distance + prefix match. Keeps error UX consistent across every command — don't inline ad-hoc `Unknown worker: …` strings.

**Prune is not cancel.** `cancelWorker`/`cancelAllWorkers` kill the RPC process and mark the registry entry as `exited` but keep it. `pruneTerminalWorkers` only removes already-terminal entries from the registry — it never touches live processes. The two are deliberate: operators want a history of finished work until they explicitly clear it. Don't auto-prune on terminal transitions; don't make cancel also remove from the registry. If you want a hard reset, the flow is `/agent-cancel all` → `/team-prune` (two steps, visible in chat).

**Config schema is v3 flat: roles are free-form, project wins by presence.** `agents-team.json` (at `~/.pi/agent/` or `<cwd-ancestor>/.pi/agent/` — ancestor walk STOPS at `homedir()` so stale files in `/tmp` or a shared ancestor can't silently bias) is the source of truth when present. Key rules:

- `schemaVersion: 3` is the current schema. The legacy top-level `version` / `defaultsVersion` field names (pre-rename) are accepted at parse time but trigger a `schema_version_mismatch` warning because they can't carry current-schema semantics reliably — the operator runs `/team-init <scope> --force` to regenerate (which backs up the old file).
- **Precedence is by file presence, not validity.** If a project file exists — valid, schema-mismatched, or even fatal-parse — project wins outright. A mismatched project layer does NOT fall through to global (which would let a stale local config silently resurface broader global roles in a repo that never sanctioned them). Invalid winning layer → built-in fallback for that scope, never a downshift to the other layer. A fatal parse on a NON-WINNING layer (broken global with a valid project, or vice-versa) is diagnostic-only — it must not disable the winning layer. Pre-fix, any fatal parse (including a broken `~/.pi/agent/agents-team.json`) short-circuited to `status: "invalid"` machine-wide; the loader now scopes fatal-parse handling to the winning layer.
- **No rights ceiling.** Role keys are free-form strings; tools/write/thinkingLevel are whatever the user declared. The loader does NOT compare user roles against built-in defaults. Platform-level safety (`launch-policy.ts`) still enforces: no `extensionMode: "inherit"` (recursion guard), and `write: true` roles require a `pathScope` at delegate time. `safety.projectRoot` defaults to `options.cwd` when no project config exists, so the containment guard (path scopes must stay within project root) always fires — without this, global-only or no-config setups would skip the guard and accept `pathScopeRoots: ["/"]`.
- **`whenToUse` vs `description`.** `whenToUse` is the canonical v3 field for the trigger sentence shown to the orchestrator in the **Available worker profiles** block. `description` is accepted as a legacy alias; `whenToUse` wins when both are present. Built-in defaults use trigger-style `"Use for / when / to ..."` phrasing — keep this style when adding new roles to the scaffold, because the orchestrator LLM delegates based on literal text matches against these sentences.
- **Prompt resolution**: `"default"`/omitted → packaged `prompts/agents/<name>.md` if the role name matches one of the seven built-ins, else the generic template at `prompts/agents/_generic-worker.md` with `{NAME}` / `{DESCRIPTION}` substituted (the `{DESCRIPTION}` placeholder is filled from the role's `whenToUse` after normalization). A path string that resolves to a readable file → that file. A string that doesn't resolve to a readable file → stored as `promptInline` on the profile spec and served verbatim. Empty / whitespace-only strings emit a `project_prompt_empty` warning and fall back to the generic template. Path-shaped strings that don't resolve (contain `/`, end in `.md`, start with `./`/`~/`/`http`) emit a `project_prompt_missing` warning so typos don't silently become 20-char inline prompts. A path that escapes the project root → hard error (`project_path_escape`, security). Symlink escapes are caught too: even if the symlink *file* is under the project root, `resolveLayerPath` follows it with `realpathSync.native` and rejects when the real target is outside the real project root.
- **Inline prompts and the generic-worker sentinel are materialized at launch time.** When a profile has `promptInline` set or `promptPath === GENERIC_WORKER_PROMPT_SENTINEL`, `launch-policy.ts` renders the full prompt (via `loadWorkerPrompt` — inline trim or `{NAME}`/`{DESCRIPTION}` substitution) and writes it to a temp file under `os.tmpdir()/pi-agents-team-prompt-<profile>-XXXXXX/prompt.md`, then passes that temp path to Pi's `--append-system-prompt`. Pre-fix, the launch path only passed a filesystem path and the sentinel is a synthetic identifier that is never a real file — workers started with either the unrendered template or a crashed read. Temp dirs are 0o600 and left for OS cleanup.
- **User strings in prompts are fenced and length-capped.** Role `name` (max 64 chars), `whenToUse` / `description` (max 500 chars) are stripped of control chars (except `\t`/`\n`) and rendered through `sanitizeProfileName` / `sanitizeDescriptionSingleLine` / `sanitizeDescriptionBlock` before landing in the orchestrator prompt or the generic worker template. `buildAvailableProfilesBlock` additionally wraps every entry with `<!-- BEGIN available-profiles -->` / `<!-- END available-profiles -->` sentinels and tells the orchestrator LLM to ignore instructions inside profile descriptions. This is defence against prompt-injection via crafted `whenToUse` in shared repos or dotfiles — a hostile config could otherwise close the enclosing block and inject new "system" guidance.
- **Toggle commands are non-destructive.** `/team-enable` / `/team-disable` never overwrite a valid config's roles. On a file that parses as JSON but drifts from the current schema (unknown top-level fields, future additions, old-shape roles), the toggle preserves the raw object and only patches `enabled`. On a file that isn't valid JSON at all, the original is copied to a timestamped backup (`YYYY-MM-DD-HHMMSS-agents-team.json`) in the same directory (seconds included so same-minute reruns don't collide; exclusive-create via `COPYFILE_EXCL` so two concurrent runs don't clobber each other's backups); then a minimal `{ schemaVersion, enabled }` replacement is written. Do not skip the backup. The shared helper lives at `src/util/backup.ts` and exposes `atomicWriteFileSync(path, body, { mode })` — all config writes stage to `<path>.tmp.<pid>.<ts>` and `renameSync` into place so a crash mid-write leaves the original file intact. Directories are created with mode 0o700 and files with mode 0o600 (noop on Windows).
- `enabled` precedence: project > global > default `true`. When false, session_start shows the disabled toast; tools refuse; `applyUi` clears status + widget.
- `PI_AGENT_TEAM_GLOBAL_CONFIG_PATH` env var overrides the global probe (tests use this for isolation; `"none"`/`""`/`"null"` skips global entirely). Both the loader and the `/team-init global` / `/team-enable global` / `/team-disable global` commands route through the shared `resolveGlobalConfigPath()` helper; pre-fix, the commands bypassed the env override and would write to the real `~/.pi/agent/agents-team.json` even when tests had the env pointed at a tmpdir.

When adding schema fields, preserve `layers[]` / `enabled` / `enabledSource` / `schemaMismatch` / `rawSchemaVersion` on `LoadedTeamProjectConfig` and `TeamProjectConfigLayer` — they drive the toast source line and the version-mismatch warning.

**Schema versioning — the two counters are different, don't confuse them.** `agents-team.json` carries two version fields, and they mean different things. When touching the config shape, decide which one to bump:

- **`schemaVersion` (aka `TEAM_PROJECT_SCHEMA_VERSION`, currently `3`)** — the **schema contract**. Bump this when the *shape* of the file changes in a way that an older loader can't correctly interpret: renamed fields, moved fields, new required fields, changed semantics of an existing field (e.g. `write: boolean` → `write: "read" | "append" | "full"`), a re-layout of the role map. Bumping `schemaVersion` is a **breaking change** — the loader compares the file's `schemaVersion` against `TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED`; mismatched files emit a `schema_version_mismatch` warning and fall back to built-in roles for that layer (or, if the winning layer is mismatched, project precedence is preserved and we fall back to built-ins without letting global take over). Also add the new number to `TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED` if you want to accept both old and new during a transition, or leave it single-valued to force a hard cutover (operator regenerates via `/team-init --force`). A normalization helper that silently translates old → new shape is OK and keeps files working without a bump — reserve the bump for cases where no honest translation exists.
- **`scaffoldVersion` (aka `TEAM_SCAFFOLD_VERSION` / `CURRENT_SCAFFOLD_VERSION`, currently `3`)** — the **scaffold freshness marker**. Bump this when the *content* of what `/team-init` would write changes, even though the shape is identical: a new default role is added, a default tool list changes, a best-practice `whenToUse` sentence is rewritten, a new optional field you want in fresh scaffolds. Older files keep loading fine (no forced regen), but every layer where `scaffoldVersion < CURRENT_SCAFFOLD_VERSION` gets `layer.scaffoldStale = true` and a soft per-layer warning toast on session start telling the operator to re-run `/team-init <scope> --force` to pick up the new defaults.

Concretely: if you're changing how the schema is *parsed* (or stored, or validated), bump `schemaVersion`. If you're changing what the scaffold *writes* while keeping parsing compatible, bump `scaffoldVersion`. If you're unsure whether a change is load-compatible, add a normalization path and bump only `scaffoldVersion` — a silent re-bump of `schemaVersion` strands every existing user config behind a warning toast and should be used sparingly.

**Both counters live in one file: `src/project-config/versions.ts`.** Edit that file — nothing else. `src/types.ts` re-exports them; `src/config.ts` exposes `CURRENT_SCAFFOLD_VERSION` as an alias. Tests and docs reference the constants rather than hardcoding literals, so a bump propagates with no other source-code churn.

The legacy top-level field names `version` (mapped to `schemaVersion`) and `defaultsVersion` (mapped to `scaffoldVersion`) are read by the loader so old files can be DETECTED and warned about; they are never the canonical field names going forward. Do not re-emit them from `/team-init`.

**Team profiles and Pi skills are different axes.** `delegate_task.profileName` must be one of the role names in the active config (whatever the user declared in `agents-team.json`, or the seven packaged names when no file is present). The Pi `[Skills]` list (e.g. `writer`, `frontend-design`, `architecting-systems`) is **not** a profile list — those are host-level capabilities the worker's Pi session can load. Pass them through the optional `delegate_task.skills: string[]` array. When `skills` is non-empty, `TeamManager.delegateTask` sets `allowSkills: true` on the launch options, and `buildWorkerProcessArgs` omits `--no-skills` so Pi's skill discovery runs for that worker. `buildWorkerTaskPrompt` renders the list in the worker prompt with "invoke each relevant skill via `/skill:<name>` (or let the matching skill activate automatically)" — Pi dispatches skills via `/skill:name` commands (the pre-fix wording said "Skill tool", which doesn't exist in Pi 0.68). The orchestrator prompt gets a dynamic **Available worker profiles** block (built in `contracts.ts:buildAvailableProfilesBlock` from `config.profiles`, fenced with `<!-- BEGIN available-profiles -->` sentinels and sanitized user strings) so the LLM always sees the currently-configured role list.

`delegate_task.profileName` is declared as `Type.String()` — Pi's TypeBox tool schema has no runtime-mutable enum. As a usability hint, the extension entrypoint mutates the field's `description` string at plugin load time to include the currently-declared role list (`"Currently declared in this session: explorer, fixer, ..."`). Pi caches the tool schema at `registerTool` time; on `/reload` the plugin re-initializes and the description refreshes.

**Cost totals: agents only, not orchestrator.** `aggregateUsage()` and the widget `Σ` line sum across every tracked worker. The orchestrator's own token/cost is Pi's footer bar (`↑ input ↓ output $cost`) — do NOT pull it into the `Σ` row. Duplicating across two surfaces would double-count when the user glances at both. The separation is intentional: footer = orchestrator, widget/`team-cost` = agent team. Terminal workers are included in `Σ` until pruned — that matches "total spent in this batch" semantics.

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
- **Don't auto-prune terminal workers.** Operators want to see the history of a batch until they clear it. Removing entries on terminal transition would hide cancelled runs before the user inspects them and would break the `Σ` total's "spent in this batch" meaning. Prune is operator-initiated only.
- **Don't add orchestrator tokens to the `Σ` row.** Pi's footer already shows them. Double-surfacing is worse than missing.

## What to do on each turn

- Before claiming code is correct: run `npm run typecheck` and `npm test`. Don't ship red tests.
- Before claiming a behavior change is done: update the relevant doc (README, `docs/*.md`, or `prompts/*.md`).
- Before adding a command or tool: check whether the widget or `/team` already covers the need.
- Before touching runtime state transitions: re-read the "Key invariants" section above. The bugs in this codebase have historically been race conditions on status transitions and spurious toasts — those are the expensive classes of mistake.
- Before changing the MockWorkerTransport shape: check which tests rely on `autoCompletePrompt`, `promptText`, and `setState`. They are the only seam for unit-testing runtime behavior without a real Pi process.
