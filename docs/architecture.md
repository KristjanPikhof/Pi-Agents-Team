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
      ├─ Dashboard overlay      (queue + inspector shell with overview/deliverable/console tabs)
      ├─ Terminal-status toasts (debounced batch per wake)
      └─ Slash commands         (/team, /team-copy, /team-prune, /team-cost, /agent-*)
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

While the worker runs, RPC events flow through the event normalizer into `applyNormalizedEvent`, which mutates the worker's `WorkerRuntimeState` (status, textBuffer, lastToolName, usage, lastSummary, pendingRelayQuestions, finalAnswer) and emits a snapshot. `TeamManager` upserts the snapshot into the registry and re-emits `state_change`, which drives both persistence and UI listeners.

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

Config writes (`/team-init`, `/team-enable`, `/team-disable`) are atomic: they stage to `<path>.tmp.<pid>.<ts>` and `renameSync` into place. Backups use `copyFileSync` with `COPYFILE_EXCL` so the original file stays in place until the new write succeeds and concurrent runs can't clobber each other's backups. A crash mid-write leaves the original file intact. Directories get mode `0o700` and files get mode `0o600` (noop on Windows).

`safety.projectRoot` always has a value at launch time: the project config's root when a project-scope config exists, else `options.cwd`. By default the launch-policy containment guard keeps path-scope roots inside that project root, so global-only and no-config setups can't accept `pathScopeRoots: ["/"]`. If the winning `agents-team.json` sets `workerAccess.allowPathsOutsideProject: true`, that guard is relaxed for delegated worker path scopes only — the visible orchestrator session and worker prompt files are unchanged. Path containment uses `realpathSync.native` so symlink escapes are caught at both load and delegate time. **`pathScope` is a prompt convention, not an OS sandbox** — Pi's `bash` tool can still execute arbitrary shell commands in the worker's cwd regardless of the declared scope. See CLAUDE.md "Path scope is a prompt convention, not an OS sandbox" for the full framing.

### Write-capable profiles need path scope

The `fixer` profile is intentionally stricter than the read-heavy roles. If `writePolicy` is `scoped-write`, `ensureWriteScope` requires explicit writable roots; launch policy throws without them. Read-only profiles use `normalizePathScope`, which permits broad inspection without write capability.

### Session restore is honest

Persisted state survives reloads via custom-typed session entries, but live worker processes do not get silently reattached. `markRestoredWorkersExited` forces every restored worker to `exited` on session start and returns the count that was flipped. The session-start handler reads Pi's `SessionStartEvent.reason` (`startup`/`reload`/`new`/`resume`/`fork`) to craft a reason-specific error string ("session resumed…", "session forked…", etc.) and, when `reason !== "startup"` and `markedCount > 0`, emits a single warning toast so the operator learns that prior workers are gone. The operator sees what existed before the reload without being lied to about process liveness.

### Wait, don't poll: mid-flight relay wake

`wait_for_agents` subscribes to `state_change` events on `TeamManager`. It resolves on one of four reasons:

- `all_terminal`: every target reached a terminal status (`idle`, `completed`, `aborted`, `error`, `exited`).
- `relay_raised`: any target raised a new relay question while running. The response carries a `newRelays` list so the orchestrator can answer without having to enumerate workers itself. Opt out with `wakeOnRelay: false`.
- `timeout`: default 5 min.
- `aborted`: external abort signal.

The baseline pending-relay count is snapshotted at wait-start per call, so previously-answered relays don't wake subsequent waits. Only a fresh length increase wakes. This is what lets the orchestrator juggle multiple in-flight workers: answer, go back to sleep, answer, go back to sleep, until `all_terminal`. Zero tokens between wakes.

### The `<final_answer>` contract

Every delegated task prompt (`buildWorkerTaskPrompt`) requires the worker's final assistant message to wrap its deliverable in a single `<final_answer>…</final_answer>` block. `extractFinalAnswer` pulls the contents into `WorkerRuntimeState.finalAnswer`; `agent_result` returns it verbatim alongside the compact summary header.

Why: gives the orchestrator a single, predictable deliverable; keeps compact state honest; makes `agent_result` the authoritative synthesis surface without needing to ship raw transcripts.

### The starting → idle race (and why `worker_state` guards it)

The initial `refreshState` fires before `promptWorker` is called, so the RPC session reports `isStreaming: false`. Naively that maps to `idle`, which is terminal and would trigger a "worker finished" toast before the worker has done anything. `applyNormalizedEvent`'s `worker_state` branch keeps a `starting` worker as `starting` while `isStreaming` is false. `flushTerminalNotifications` re-checks each queued entry's current status before firing the batched toast so any race that slips past is dropped.

### Placeholder relays are filtered at parse time

Workers occasionally emit `relay_question: none` (or `n/a`, `-`, `null`, etc.) instead of omitting the field when they have nothing to ask. `extractRelayQuestions` (`src/comms/summary.ts`) normalizes the value and returns an empty array for any known placeholder. The extension's relay-toast listener has a second-line guard: it refuses to notify when the question string is empty or whitespace-only. Workers are told in `buildWorkerTaskPrompt` to omit the field entirely. Both guards exist because models drift.

## Compact runtime state

`WorkerRuntimeState` (see `src/types.ts`) is the canonical view of a worker:

- identity: `workerId`, `profileName`, `sessionMode`
- lifecycle: `status`, `startedAt`, `lastEventAt`, `error`
- work: `currentTask`, `lastToolName`
- output: `lastSummary` (headline + readFiles + changedFiles + risks + nextRecommendation), `finalAnswer`
- supervision: `pendingRelayQuestions`
- accounting: `usage` (turns, input/output tokens, cache, costUsd, contextTokens)

`WorkerSummary` has hard caps from `config.summaries` (`maxHeadlineLength: 160`, `maxChangedFiles: 8`, `maxRelayQuestions: 3`, `maxItemsPerWorker: 3`). Transcripts are kept only in-memory on the `WorkerManager` (`record.textBuffer`) and a bounded console ring (`CONSOLE_BUFFER_LIMIT`) for the dashboard. They are never persisted.

## What gets persisted

Persisted session state includes:

- delegated task metadata (title, goal, cwd, contextHints, pathScope)
- worker ids and compact runtime state
- compact summaries
- pending relay questions
- dashboard snapshot entries

Persisted session state does **not** include:

- full worker transcripts
- raw streaming deltas
- tool output dumps
- the `<final_answer>` block on disk (it lives on `WorkerRuntimeState` but storage honors the compact-state rule; `config.persistence.storeTranscripts` is `false` by default)

## Operator surface

Slash commands are supervision controls, not alternate chat channels:

- `/team` and `/team <worker-id>`
- `/team-copy <worker-id>`
- `/agent-result`, `/agent-steer`, `/agent-followup`, `/agent-cancel`

The always-visible widget (glyph + id + profile + short detail, counts bar) replaces the old `/team-status`, `/agents`, and `/ping-agents` commands. Fresh RPC state is pulled when `/team` opens and whenever the operator presses `r` inside the overlay.

### Widget layout rules

`buildTeamWidgetLines` (`src/ui/status-widget.ts`):

- **Hidden when empty.** Returns `[]` if no workers are tracked; the extension then clears the widget via `setWidget(key, undefined)`. The extension title bar still shows "Pi Agents Team (mode)" via `titleTemplate`.
- **Single column** when ≤ 6 workers (cap at 8 visible rows). Per-worker row is one glyph + id + profile + 38-col truncated detail.
- **Two columns** when > 6 workers: left column padded to 38 cols with visible-width-aware spaces, then `  ` + right cell. Cap at 16 visible workers (2 × 8); the rest show as `  +N more · /team to view`.
- **Width enforcement.** Every returned line passes through `truncateToWidth(line, HEADER_WIDTH=78)`. Both widget and overlay use pi-tui's `visibleWidth` / `truncateToWidth`, not raw `.length` / `.slice`, because braille spinner glyphs, emoji, and combining chars miscount under code-unit length and previously crashed pi-tui's render validator.

### Overlay layout rules

`openTeamDashboardOverlay` (`src/ui/overlay.ts`):

- **Responsive shell.** Wide terminals render queue and inspector side by side; narrower terminals stack them while keeping the same keyboard model.
- **Sticky help + status.** The keybinding help line is rendered immediately under the tab row, not at the bottom, and the transient `» …` status line also stays above the scrolling body. Terminals that clip the overlay height can't hide either line.
- **Live ping on open** and on `r`. The overlay issues `teamManager.pingWorkers({ mode: "active" })` so token counts and streaming status are current.
- **Direct focus.** `/team <worker-id>` opens the overlay already on that worker's inspector, with Overview selected by default. Tab completion on the `/team` argument pulls live worker ids.
- **Detail tabs.** Overview front-loads status/task/usage/relay context, Deliverable starts with the worker's `<final_answer>` block and supporting artifacts, and Console shows the bounded event timeline.
- **Copy.** `y` (or `/team-copy <worker-id>`) copies a full markdown payload (task, summary, relays, usage, final answer, latest assistant text, console timeline) via pbcopy / clip.exe / wl-copy / xclip / xsel.

## Notifications

Two kinds of toasts fire from the extension's `onStateChange` listener:

- **Terminal transitions.** When one or more workers flip to a terminal status, the listener batches them through a 400 ms debounce and emits one toast (`✓ N workers finished: w1, w2…`). The batch is filtered against current status at flush time to avoid spurious "finished" messages from transient state.
- **New relay questions.** When a worker's `pendingRelayQuestions` count goes up **and** the newest relay has a non-empty question string, the listener emits a warning toast with a truncated preview. Placeholder and whitespace-only questions are suppressed.

Both are UI-only. The orchestrator prompt explicitly instructs the model to ignore them, because `wait_for_agents` already surfaces terminal transitions and relay wakes as a tool result.

### Spinner animation

A 120 ms `setInterval` animates the widget while `hasAnimatedWorkers(state)` is true (any worker in `starting`/`running`/`waiting_followup`). The tick re-applies the widget at the next frame. It starts on state change, stops when the last non-terminal worker finishes, stops on `session_shutdown`, and calls `.unref()` so it never blocks process exit.

## What to read next

- [`operations.md`](operations.md) for install, smoke, steer, troubleshoot
- [`profiles.md`](profiles.md) for profile policy and write-scope rules
- [`prompting.md`](prompting.md) for orchestrator and worker prompt contracts
