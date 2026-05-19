# Pi Agents Team architecture

## TL;DR

One visible Pi session stays the orchestrator. All bounded work moves into RPC-backed background workers spawned via `pi --mode rpc`. The orchestrator never mirrors worker transcripts into its own context: it reads compact runtime state plus a verbatim `<final_answer>` block per worker and synthesizes from that.

## Why this exists

A single long Pi session runs into context pressure fast. This package moves bounded tasks into separate worker sessions while preserving one coherent orchestrator thread and one user-facing voice.

## Core contract

Three opinionated choices:

1. **One user-facing agent.** The main session is always the orchestrator.
2. **Background workers only.** Workers talk to the orchestrator, not to the user.
3. **Compact state over transcripts.** The orchestrator stores summaries, relay questions, status, usage, and a `<final_answer>` block per worker. It does not mirror full worker conversations back into the main context.

## Runtime topology

```text
User
  ↓
Main Pi session (orchestrator)
  ↓
Package entrypoint (extensions/index.ts)
  │   └─ delegates to internal implementation entrypoint (extensions/pi-agent-team/index.ts)
  ├─ Control plane
  │   ├─ TeamManager            (coordinates delegation, snapshots, waits)
  │   ├─ TaskRegistry           (active workers + task metadata)
  │   └─ Persistence snapshots  (append-only state custom entries)
  ├─ Runtime layer
  │   ├─ WorkerProcess          (spawns pi --mode rpc --no-session)
  │   ├─ RpcClient              (jsonl-lf transport)
  │   ├─ Event normalizer       (RPC events → NormalizedWorkerEvent)
  │   └─ WorkerManager          (applies events to WorkerRuntimeState)
  ├─ Profiles + safety
  │   ├─ Profile loader         (reads markdown frontmatter in profiles/)
  │   ├─ Launch policy          (resolves model/tools/thinking/extension mode)
  │   └─ Path-scope checks      (required for scoped-write profiles)
  ├─ Comms layer
  │   ├─ Summary parser         (compact headline + files + risks)
  │   ├─ Relay queue            (extracts relay_question + assumption)
  │   ├─ Agent messaging        (routes steer vs follow_up)
  │   └─ Ping helpers           (passive snapshot text)
  └─ Operator UI
      ├─ Footer status          (buildTeamStatusLine)
      ├─ Widget                 (buildTeamWidgetLines)
      ├─ Dashboard overlay      (Workers/Inspect/Console/Cost tab bar with action bar + inline modal)
      ├─ Terminal-status toasts (debounced batch per wake)
      └─ Slash commands         (/team, /team-steer, /team-stop, /team-copy, /team-result, /team-enable, /team-init)
```

## Delegation flow

```text
delegate_task (tool)
  → TeamManager.delegateTask
      → resolveProfile
      → applyLaunchPolicy      (extensionMode + path scope + tools)
      → registerTask           (TaskRegistry)
      → WorkerManager.launchWorker
          → spawnWorkerProcess (pi --mode rpc)
          → RpcClient wires onEvent/onError
          → refreshState       (initial RPC state)
      → WorkerManager.promptWorker (status → "running")
  ← returns { worker, task }
```

When `delegate_task.reuseWorkerId` is set, the path forks before launchWorker:

```text
delegate_task (tool, with reuseWorkerId)
  → TeamManager.delegateTask
      → reuseWorkerForTask
          → registry.getWorker     (must exist)
          → status check           (idle | waiting_followup; reject otherwise)
          → profile match          (same profileName)
          → applyLaunchPolicy      (compute would-be plan)
          → launch-snapshot diff   (model, tools, cwd, systemPromptPath,
                                    extensionMode, thinkingLevel, allowSkills)
          → refreshStats           (pull current context budget)
          → context budget guard   (reject >=80% or <=32768 remaining tokens)
          → registerTask           (fresh taskId)
          → WorkerManager.reuseWorker
              → reset per-task state (textBuffer, finalAnswer, lastTool,
                                       relayQuestions, lastSummary, error)
              → promptWorker        (existing RPC client, status → "running")
  ← returns { worker, task }
```

Reuse re-prompts an idle/waiting_followup worker over its live RPC client. Process-launch flags (model, tools, cwd, prompt path, extension mode, skill discovery) are baked at spawn and can't change between tasks. `WorkerManager` snapshots them at launch and `reuseWorkerForTask` rejects mismatches with a per-field error, so the orchestrator either aligns the request or drops `reuseWorkerId` and spawns fresh. Cross-profile reuse is rejected for the same reason: different role means different prompt path.

After launch-setting checks, reuse refreshes worker stats and rejects saturated context before registering the new task or sending the prompt. The hard guard rejects `contextPercent >= 80` or `contextRemainingTokens <= 32768`, with an error that includes known budget values and says to delegate fresh. Unknown/null context does not hard-reject; the orchestrator prompt instead biases long, exploratory, or multi-lane work toward fresh workers. There is intentionally no auto-compact fallback.

While the worker runs, RPC events flow through the event normalizer into `applyNormalizedEvent`, which mutates the worker's `WorkerRuntimeState` (status, textBuffer, lastToolName, usage, requested/effective thinking levels, lastSummary, pendingRelayQuestions, finalAnswer) and emits a snapshot. `TeamManager` upserts the snapshot into the registry and re-emits `state_change`, which drives both persistence and UI listeners.

## Key decisions

### Pi RPC is the worker transport

Workers run through `pi --mode rpc --no-session`. That gives us prompt, steer, follow-up, abort, state, and stats commands without inventing another agent protocol. Transport is line-delimited JSON (`jsonl-lf`).

### Workers launch with reduced discovery

The default launch mode is `worker-minimal`. That disables recursive extension discovery and keeps workers from accidentally booting the full orchestrator package again. `preventRecursiveOrchestrator: true` in the safety config hard-rejects any attempt to launch with `extensionMode: "inherit"`.

Worker-minimal mode also disables Pi skill discovery unless the delegated task
sets `skills`. When requested skills are present, `TeamManager` passes
`allowSkills` to the worker process so Pi loads available skill context and the
worker can apply the requested installed skill names.

### Project role config is discovered once, then frozen

On session start the extension calls `loadActiveTeamConfig({ cwd })`. If it finds the nearest ancestor `agents-team.json`, it resolves project prompt paths and scope roots relative to that file's directory, merges the result onto the built-in profiles, and hands the merged config to `TeamManager`. That merged config is the active runtime authority for the session.

The runtime does **not** hot-reload `agents-team.json` mid-session. This avoids a class of bugs where active workers were launched under one role definition and later supervision/tooling reads a different one. If the WINNING config layer is invalid, the extension keeps packaged defaults available for display but marks delegation disabled until the next fixed session start. A fatal parse on a NON-WINNING layer (e.g. a typo in `~/.pi/agent/agents-team.json` while a valid project-local config exists) is diagnostic-only — project wins by file presence, and the broken global surfaces as a warning rather than disabling delegation.

Boot freshness warnings read `LoadedTeamProjectConfig.activeConfigFreshness`, so only the active layer participates: project-local wins by presence, otherwise global, otherwise none. A stale `scaffoldVersion` or a missing active `scaffoldVersion` on a current-schema file is a soft freshness warning; schema mismatch and fatal parse remain separate warning/error paths. Stale non-winning layers do not toast by default. Freshness toasts are de-duped per process by active scope plus the active version value, or `unknown` when the active file omits `scaffoldVersion`.

Config writes (`/team-init`, `/team-enable`) are atomic: they stage to `<path>.tmp.<pid>.<ts>` and `renameSync` into place. Backups use `copyFileSync` with `COPYFILE_EXCL` so the original file stays in place until the new write succeeds and concurrent runs can't clobber each other's backups. A crash mid-write leaves the original file intact. Directories get mode `0o700` and files get mode `0o600` (noop on Windows).

`safety.projectRoot` always has a value at launch time: the project config's root when a project-scope config exists, else `options.cwd`. Delegated worker path scopes may point outside that root by default, so global-only and no-config setups can accept operator-supplied roots such as `/tmp` or sibling repos. If the winning `agents-team.json` sets `workerAccess.allowPathsOutsideProject: false`, the launch-policy containment guard restricts delegated worker path scopes to the project root/current cwd. The visible orchestrator session and worker prompt files are unchanged: prompt-file containment always applies. When containment is enforced, path checks use `realpathSync.native` so symlink escapes are caught at both load and delegate time. **`pathScope` is a prompt convention, not an OS sandbox** — Pi's `bash` tool can still execute arbitrary shell commands in the worker's cwd regardless of the declared scope. See CLAUDE.md "Path scope is a prompt convention, not an OS sandbox" for the full framing.

### Write-capable profiles need path scope

The `fixer` profile is intentionally stricter than the read-heavy roles. If `writePolicy` is `scoped-write`, `ensureWriteScope` requires explicit writable roots; launch policy throws without them. Read-only profiles use `normalizePathScope`, which permits broad inspection without write capability.

### Session restore is honest

Persisted state survives reloads via custom-typed session entries, but live worker processes do not get silently reattached. `markRestoredWorkersExited` forces every restored worker to `exited` on session start and returns the count that was flipped. The session-start handler reads Pi's `SessionStartEvent.reason` (`startup`/`reload`/`new`/`resume`/`fork`) to craft a reason-specific error string ("session resumed…", "session forked…", etc.) and, when `reason !== "startup"` and `markedCount > 0`, emits a single warning toast so the operator learns that prior workers are gone. The operator sees what existed before the reload without being lied to about process liveness.

### Wait, don't poll: mid-flight relay wake

`wait_for_agents` subscribes to `state_change` events on `TeamManager`. `TeamManager.waitForTerminal` resolves the four event-driven reasons (`all_terminal`, `relay_raised`, `timeout`, `aborted`), and the tool wrapper adds `no_workers` before subscribing when no targets are tracked. `details.reason` keeps that canonical machine value; the formatted text uses human-readable labels:

- `all_terminal`: every target reached a done/stopped status (`idle`, `completed`, `aborted`, `error`, `exited`). The formatted result starts with `Wait: all agents finished`, reports how many agents finished or stopped, and says to read results for the worker ids.
- `relay_raised`: any target raised a new relay question while running. The response carries a `newRelays` list, and the formatted result starts with `Wait: relay question raised`, lists profile/id/question plus a reply hint, and says to wait again after answering. Opt out with `wakeOnRelay: false`.
- `timeout`: default 5 min. The formatted result starts with `Wait: timeout` and recommends waiting again or inspecting status.
- `aborted`: external abort signal. The formatted result starts with `Wait: aborted` and recommends inspecting status or cancelling unwanted agents.
- `no_workers`: no tracked workers matched the wait request. The formatted result starts with `Wait: no agents` and tells the orchestrator to delegate first.

The baseline pending-relay count is snapshotted at wait-start per call, so previously-answered relays don't wake subsequent waits. Only a fresh length increase wakes. This is what lets the orchestrator juggle multiple in-flight workers: answer, go back to sleep, answer, go back to sleep, until `all_terminal`. Zero tokens between wakes.

### The `<final_answer>` contract

Every delegated task prompt (`buildWorkerTaskPrompt`) requires the worker's final assistant message to wrap its deliverable in a single `<final_answer>…</final_answer>` block. `extractFinalAnswer` pulls the contents into `WorkerRuntimeState.finalAnswer`; `agent_result` returns it verbatim alongside the compact summary header.

Why: gives the orchestrator a single, predictable deliverable; keeps compact state honest; makes `agent_result` the authoritative synthesis surface without needing to ship raw transcripts.

### The starting → idle race (and why `worker_state` guards it)

The initial `refreshState` fires before `promptWorker` is called, so the RPC session reports `isStreaming: false`. Naively that maps to `idle`, which is terminal and would trigger a "worker finished" toast before the worker has done anything. `applyNormalizedEvent`'s `worker_state` branch keeps a `starting` worker as `starting` while `isStreaming` is false. `flushTerminalNotifications` re-checks each queued entry's current status before firing the batched toast so any race that slips past is dropped.

### Close vs cancel vs prune

Three verbs with different intents. Don't conflate them.

| Verb | Target status | What it does | Final status |
|---|---|---|---|
| `/team-stop` (cancel path) | non-terminal (`starting`, `running`) | Aborts the active stream and SIGTERMs the worker process. | `exited` (or `aborted` if the abort raced) |
| `/team-stop` (close path) | reusable (`idle`, `waiting_followup`) | Disposes the live RPC handle, sets the `closing` flag so `worker_exit` lands as `exited` not `aborted`. | `exited` |
| overlay `[p]` prune | terminal (`idle`, `completed`, `aborted`, `error`, `exited`) | Calls `WorkerManager.removeWorker` (which closes any leftover live handle for `idle`/`waiting_followup` entries), unsubscribes RPC listeners, folds the worker's usage into `prunedWorkerUsageTotals`, then drops the registry entry. | (entry removed) |

`closing` is a per-record flag on `WorkerRuntimeRecord`. `closeWorker` sets it before disposing the handle so the natural `worker_exit` event fired by the dispose can map to `exited` instead of the default `signal === "SIGTERM" ? "aborted" : "exited"` branch. Without the flag, an explicit close would arrive as a fake abort.

`pruneTerminalWorkers` is async because `WorkerManager.removeWorker` awaits handle disposal for any reusable worker still holding a live session. Operators get a single-shot prune; the runtime guarantees no leaked processes after the await resolves. Usage retention happens in the registry removal path, so each removed worker is counted once and a later no-op prune cannot double-count it.

### Placeholder relays are filtered at parse time

Workers occasionally emit `relay_question: none` (or `n/a`, `-`, `null`, etc.) instead of omitting the field when they have nothing to ask. `extractRelayQuestions` (`src/comms/summary.ts`) normalizes the value and returns an empty array for any known placeholder. The extension's relay-toast listener has a second-line guard: it refuses to notify when the question string is empty or whitespace-only. Workers are told in `buildWorkerTaskPrompt` to omit the field entirely. Both guards exist because models drift.

## Compact runtime state

`WorkerRuntimeState` (see `src/types.ts`) is the canonical view of a worker:

- identity: `workerId`, `profileName`, `sessionMode`
- lifecycle: `status`, `startedAt`, `lastEventAt`, `error`
- work: `currentTask`, `lastToolName`
- thinking: `requestedThinkingLevel`, `effectiveThinkingLevel`
- output: `lastSummary` (headline + readFiles + changedFiles + risks + nextRecommendation), `finalAnswer`
- supervision: `pendingRelayQuestions`
- accounting: `usage` (turns, input/output tokens, cache, costUsd, contextTokens, contextWindow, contextPercent, contextRemainingTokens)

`WorkerSummary` has hard caps from `config.summaries` (`maxHeadlineLength: 160`, `maxChangedFiles: 8`, `maxRelayQuestions: 3`, `maxItemsPerWorker: 3`). Transcripts are kept only in-memory on the `WorkerManager`: `record.textBuffer` (raw concatenated assistant text), a bounded console ring (`CONSOLE_BUFFER_LIMIT`) for the dashboard, and a separate per-worker assistant-chunk ring buffer (`ASSISTANT_BUFFER_CHUNK_CAP = 4096` text-delta chunks — *not* rendered lines, since one delta may contain `\n`s — `ASSISTANT_BUFFER_BYTE_CAP = 256 KB`, monotonic per-task indexes, exposed via `getAssistantTail(workerId, fromIndex?)` and `onAssistantChunk(listener)`) that powers the overlay's Console live-tail. Memory is bounded by the byte cap; the chunk cap defends against many tiny deltas. Reuse resets the chunk buffer and rewinds `nextIndex` to 0. Nothing here is persisted.

`requestedThinkingLevel` is the launch-policy output sent to Pi. `effectiveThinkingLevel` is read back from RPC `get_state.thinkingLevel` and can differ when Pi clamps unsupported model-family levels. `WorkerManager` emits a `thinking_clamped` normalized event for that mismatch so the extension can notify once per worker/requested/effective tuple.

## What gets persisted

Persisted session state includes:

- delegated task metadata (title, goal, cwd, contextHints, pathScope)
- worker ids and compact runtime state
- compact summaries
- pending relay questions
- dashboard snapshot entries
- `prunedWorkerUsageTotals`, an aggregate-only retained usage bucket for terminal workers removed by prune

Persisted session state does **not** include:

- full worker transcripts
- raw streaming deltas
- tool output dumps
- per-pruned-worker history after prune; only the aggregate `prunedWorkerUsageTotals` bucket remains
- the `<final_answer>` block on disk (it lives on `WorkerRuntimeState` but storage honors the compact-state rule; `config.persistence.storeTranscripts` is `false` by default)

## Routing mode

`TeamManager.routingMode` is `"team"` or `"solo"`. It gates `delegate_task`, swaps the orchestrator profile catalog for a one-line solo directive, and collapses the widget to a single `Pi Agents Team — solo` line when workers are tracked (or hides the widget entirely when none are). The bottom status line shows solo routing explicitly (`Orchestrator · Solo · Working...` / `Orchestrator · Solo · Idle`) and otherwise reports `Orchestrator · Working...` or `Orchestrator · Idle`, followed by a rotating app tip such as `Tip: Use /team to view workers`. `setRoutingMode` emits `state_change` so the extension's listener re-renders without reload.

The initial mode is derived once per `session_start` from the loaded config:

| Loaded config | Initial mode |
|---|---|
| `enabled: false` or invalid (delegation off) | `solo` |
| `enabled: true`, no persisted `routingMode` | `team` |
| `enabled: true`, persisted `routingMode` | that value |

`/team-enable on|off` flips the in-memory mode and persists `routingMode` to disk so the choice survives restart. The persistence target is resolved in this order: `--persist global|local` if passed; otherwise `LoadedTeamProjectConfig.sourcePath` (mapped back to its scope via `deriveScopeFromSourcePath`) when a config layer is loaded; otherwise a fresh local stub at `<cwd>/.pi/agent/agents-team.json`. Writes go through `atomicWriteFileSync` and shallow-merge into the existing JSON, so roles, `enabled`, and `workerAccess` survive the patch. The loader pulls the persisted value into `LoadedTeamProjectConfig.persistedRoutingMode` on the next `session_start`.

Routing toggles run through `ensureNotReloading()` like the orchestrator tools, so a toggle fired during the `session_start` config swap fails fast instead of mutating a soon-to-be-disposed `TeamManager`.

Routing only narrows behavior. It does not stop live workers; `agent_status`, `agent_result`, `agent_message`, `ping_agents`, `wait_for_agents`, and `agent_cancel` stay callable in solo so workers spawned earlier can still be inspected, steered, or cancelled.

## Operator surface

Slash commands are supervision controls, not alternate chat channels:

- `/team` and `/team <worker-id>`
- `/team-enable on|off` (and `--persist global|local`)
- `/team-steer <id|all> <message> [--queue]`
- `/team-stop <id|all>`
- `/team-copy <id>`, `/team-result <id>`
- `/team-init [global|local] [--force]`

The always-visible widget (glyph + id + profile + short detail, counts bar) replaces the old `/team-status`, `/agents`, and `/ping-agents` commands. It remains the source of active/relay/worker counts; static command tips live in the bottom status line instead of the top widget. Fresh RPC state is pulled when `/team` opens and whenever the operator presses `r` inside the overlay.

### Widget layout rules

`buildTeamWidgetLines` (`src/ui/status-widget.ts`):

- **Hidden when empty.** Returns `[]` if no workers are tracked and no retained-pruned usage exists; the extension then clears the widget via `setWidget(key, undefined)`. Retained usage can still render the compact `Σ` line after worker rows are pruned. The extension title bar still shows "Pi Agents Team (mode)" via `titleTemplate`.
- **Single column with bounded retention.** Per-worker rows are one glyph + id + profile + title/detail + status/elapsed, capped at 8 visible workers. Active rows (`starting`/`running` or workers with relay questions) stay visible; terminal rows (`idle`, `completed`, `aborted`, `error`, `exited`) are retained for five minutes, then summarized as old hidden rows until pruned.
- **Elapsed display.** Active rows display elapsed time from the current task's `createdAt` when present, falling back to worker `startedAt`. This keeps reused workers from showing worker age as task age without changing reuse or lifecycle semantics.
- **Full registry handoff.** The compact widget filters old/overflow rows for display only and always points to `/team`; the `/team` overlay is the full live registry for inspecting currently tracked workers.
- **Width enforcement.** Every returned line passes through `truncateToWidth(line, HEADER_WIDTH=78)`. Both widget and overlay use pi-tui's `visibleWidth` / `truncateToWidth`, not raw `.length` / `.slice`, because braille spinner glyphs, emoji, and combining chars miscount under code-unit length and previously crashed pi-tui's render validator.

### Overlay layout rules

`openTeamDashboardOverlay` (`src/ui/overlay.ts`):

- **Top tab bar.** `Workers / Inspect / Console / Cost` with `1`–`4` hotkeys and `tab` / `shift+tab` cycling. The bar appends a `solo` badge when `teamManager.routingMode === "solo"`.
- **Persistent action bar.** Single-line footer: `[s]teer [m]sg [n]ew [c]lose [x]cancel [p]rune [r]efresh [y]copy [q]uit`. Each key dispatches the matching `TeamManager` call against the selected worker. `s`, `m`, and `n` open an inline single-line modal (label + buffer + cursor) above the action bar; `enter` submits, `esc` cancels.
- **Right-side stack panel.** The overlay is a single right-anchored panel. `Workers`, `Inspect`, `Console`, and `Cost` are selected through the top tab bar; Inspect and Console do not render a separate roster beside the body.
- **Live ping on open** and on `r`. The overlay issues `teamManager.pingWorkers({ mode: "active" })` so token counts and streaming status are current.
- **Direct focus.** `/team <worker-id>` opens the overlay already on the Inspect tab for that worker. Tab completion on the `/team` argument pulls live worker ids.
- **Inspect/Console follow.** Console subscribes to `teamManager.onAssistantChunk` and reads `getAssistantTail(workerId)` on render; Inspect uses the latest worker transcript in the same scroll frame as status/task/summary/final answer. Both tabs expose a compact follow/paused header (`[follow]` or `[paused f/G]` plus `scroll start-end / total`). `f` toggles follow, `G` jumps to the tail and follows, `g` jumps top and pauses, and manual scroll/page keys (`↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `b`/`space`, `ctrl+u`/`ctrl+d`) pause follow. Per-worker isolation is enforced by tying visible chunks/transcripts to `state.selectedWorkerId`.
- **Reuse hint.** Idle / waiting_followup workers render `[reuse]` in the roster row and `[reusable]` in the Inspect header. The `n` modal always delegates a fresh worker (never silently reuses the selected one); reuse is intentionally exposed only via `delegate_task.reuseWorkerId` from the orchestrator side.
- **Copy.** `y` (or `/team-copy <worker-id>`) copies a full markdown payload (task, summary, relays, usage, final answer, latest assistant text, console timeline) via pbcopy / clip.exe / wl-copy / xclip / xsel.

### Overlay text formatting rules

Inspect and Console share the local text wrapping helpers in `src/ui/overlay.ts` (`sanitizeText`, `classifyTextLine`, `wrapTextLine`, `wrapLines`, and `enforceWidth`). The helpers are intentionally UI-local because they depend on `@earendil-works/pi-tui` ANSI-aware `visibleWidth` / `truncateToWidth` semantics and the overlay's row budget.

Key invariants:

- **Content/event split.** Inspect builds a structured text document from worker state (`buildInspectText`) with explicit section dividers for Status, Task, Needs operator, Summary, Final answer, and Latest assistant text. Console builds assistant text and console events separately (`buildConsoleLines`), rendering assistant chunks before the `— events —` timeline when both exist.
- **Readable report shapes.** The formatter preserves recognizable Markdown-like headings, tables, table separators, list markers, horizontal rules, indented/code-like lines, and stack-trace-like lines. Continuation lines use a small prefix (or preserved indentation for code) rather than collapsing the body into single-line ellipses.
- **ANSI-width safety.** All wrapping and frame padding use terminal visible width, not JavaScript string length. Control characters and tabs are normalized before measurement, while this package's own ANSI styling is preserved for `pi-tui` to measure correctly.
- **Row-budget safety.** The overlay returns exactly `floor(terminal.rows * 0.9)` rows to match `TEAM_DASHBOARD_OVERLAY_OPTIONS.maxHeight`. Body content is sliced within the frame; on tiny terminals where fixed chrome alone exceeds the budget, the final framed output is clamped while preserving the top/bottom border rows.
- **Compact chrome.** The tab/help/action rows and follow header must fit laptop-width panels without ellipsizing the navigation hints that operators need (`space`/`b`, `g`/`G`, and `f`).

## Notifications

Three kinds of toasts fire from extension listeners:

- **Terminal transitions.** When one or more workers flip to a terminal status, the listener batches them through a 400 ms debounce and emits one toast (`✓ N workers finished: w1, w2…`). The batch is filtered against current status at flush time to avoid spurious "finished" messages from transient state.
- **New relay questions.** When a worker's `pendingRelayQuestions` count goes up **and** the newest relay has a non-empty question string, the listener emits a warning toast with a truncated preview. Placeholder and whitespace-only questions are suppressed.
- **Thinking clamp.** When `WorkerManager` emits `thinking_clamped`, the event listener emits one warning toast for the worker/requested/effective tuple. This surfaces Pi's silent model-family clamp without changing worker liveness.

All are UI-only. The orchestrator prompt explicitly instructs the model to ignore them, because `wait_for_agents` already surfaces terminal transitions and relay wakes as a tool result.

### Spinner animation

A 120 ms `setInterval` animates the widget while `hasAnimatedWorkers(state)` is true (any worker in `starting`/`running`/`waiting_followup`). The tick re-applies the widget at the next frame. It starts on state change, stops when the last non-terminal worker finishes, stops on `session_shutdown`, and calls `.unref()` so it never blocks process exit.

A separate 15 s managed `setInterval` rotates the bottom status-line tip while the team UI is active. It is unref'd, restarts cleanly on session reload, and stops when there is no UI, the team UI is inactive, or `session_shutdown` runs.

## What to read next

- [`operations.md`](operations.md) for install, smoke, steer, troubleshoot
- [`profiles.md`](profiles.md) for profile policy and write-scope rules
- [`prompting.md`](prompting.md) for orchestrator and worker prompt contracts
