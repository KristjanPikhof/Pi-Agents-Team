# Pi Agent Team architecture

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
Extension entrypoint (extensions/pi-agent-team/index.ts)
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
      ├─ Dashboard overlay      (list view + summary/console tabs)
      ├─ Terminal-status toasts (debounced batch per wake)
      └─ Slash commands         (/team, /agents, /ping-agents, /agent-*)
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

### Write-capable profiles need path scope

The `fixer` profile is intentionally stricter than the read-heavy roles. If `writePolicy` is `scoped-write`, `ensureWriteScope` requires explicit writable roots; launch policy throws without them. Read-only profiles use `normalizePathScope`, which permits broad inspection without write capability.

### Session restore is honest

Persisted state survives reloads via custom-typed session entries, but live worker processes do not get silently reattached. `markRestoredWorkersExited` forces every restored worker to `exited` on session start. The operator sees what existed before the reload without being lied to about process liveness.

### Wait, don't poll

`wait_for_agents` subscribes to `state_change` events on `TeamManager` and resolves exactly once every targeted worker reaches a terminal status (`idle`, `completed`, `aborted`, `error`, `exited`). It consumes zero tokens while waiting. The orchestrator prompt forbids `ping_agents` loops and `sleep` in bash for the same reason.

### The `<final_answer>` contract

Every delegated task prompt (`buildWorkerTaskPrompt`) requires the worker's final assistant message to wrap its deliverable in a single `<final_answer>…</final_answer>` block. `extractFinalAnswer` pulls the contents into `WorkerRuntimeState.finalAnswer`; `agent_result` returns it verbatim alongside the compact summary header.

Why: gives the orchestrator a single, predictable deliverable; keeps compact state honest; makes `agent_result` the authoritative synthesis surface without needing to ship raw transcripts.

### The starting → idle race (and why `worker_state` guards it)

The initial `refreshState` fires before `promptWorker` is called, so the RPC session reports `isStreaming: false`. Naively that maps to `idle`, which is terminal and would trigger a "worker finished" toast before the worker has done anything. `applyNormalizedEvent`'s `worker_state` branch keeps a `starting` worker as `starting` while `isStreaming` is false. `flushTerminalNotifications` re-checks each queued entry's current status before firing the batched toast so any race that slips past is dropped.

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

- `/team`, `/team-status`, `/agents`
- `/ping-agents [active]`
- `/agent-result`, `/agent-steer`, `/agent-followup`, `/agent-cancel`

The `/team` overlay has two tabs per worker: **Summary** (status, task, summary headline, relays, usage, latest assistant text) and **Console** (ring-buffered timeline of status transitions, tool starts/ends, assistant text flushes). Keys: `j/k` or arrow keys to scroll, `PgUp/PgDn`, `g/G` for top/bottom, `s/c` to switch tabs, `r` to refresh, `esc` to back out, `q` to close.

## Notifications

Two kinds of toasts fire from the extension's `onStateChange` listener:

- **Terminal transitions.** When one or more workers flip to a terminal status, the listener batches them through a 400 ms debounce and emits one toast (`✓ N workers finished — w1, w2…`). The batch is filtered against current status at flush time to avoid spurious "finished" messages from transient state.
- **New relay questions.** When a worker's `pendingRelayQuestions` count goes up, the listener emits a warning toast with a truncated preview (`❓ w3 (fixer) needs guidance: …`).

Both are UI-only. The orchestrator prompt explicitly instructs the model to ignore them, because `wait_for_agents` already surfaces terminal transitions as a tool result.

## What to read next

- [`operations.md`](operations.md) for install, smoke, steer, troubleshoot
- [`profiles.md`](profiles.md) for profile policy and write-scope rules
- [`prompting.md`](prompting.md) for orchestrator and worker prompt contracts
