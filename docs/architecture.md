# Pi Agent Team Architecture

## Purpose

Pi Agent Team turns a normal Pi session into an **orchestrator-led team session**.

After the package is installed and loaded:

- the **main Pi session becomes the orchestrator**
- the **orchestrator is the only user-facing agent**
- all other agents run as **RPC-backed worker sessions**
- workers do **not** chat with the user directly
- workers receive tasks from the orchestrator and report back with compact results, status, and relay messages

This design preserves the orchestrator's context window by pushing detailed execution into isolated worker sessions.

---

## Core UX contract

### User experience

The user should feel like they are talking to **one smart lead agent**, not a swarm of separate chatbots.

The orchestrator:

- talks to the user
- interprets goals
- decides whether to do work directly or delegate
- selects the right specialist
- supervises ongoing work
- asks the user clarifying questions when needed
- integrates worker results into a coherent response

Workers:

- never speak to the user by default
- never ask the user questions directly
- never become the visible “main agent” in the session
- communicate only with the orchestrator unless the operator explicitly inspects them via commands/UI

### Operator experience

The user may inspect or control workers through dedicated commands and UI, for example:

- `/team`
- `/agents`
- `/ping-agents`
- `/agent-steer <id> <message>`
- `/agent-followup <id> <message>`
- `/agent-cancel <id>`

These are operator controls, not direct worker chat.

---

## Design goals

1. **Preserve orchestrator context**
   - keep raw worker transcripts out of the main session unless explicitly requested
2. **Enable live control**
   - orchestrator and operator can steer running workers
3. **Keep workers isolated**
   - each worker has its own Pi RPC session and context window
4. **Keep the main session coherent**
   - user sees one orchestrator-driven thread
5. **Make delegation explicit and safe**
   - role selection, path ownership, recursion controls, and launch policy are enforced
6. **Stay Pi-native**
   - use Pi extensions, Pi package loading, Pi RPC mode, and Pi UI primitives
7. **Reuse ideas, not copied prompts**
   - adapt delegation logic from oh-my-opencode-slim into Pi-native prompt contracts without copying text or branding

---

## Non-goals

- building a standalone app outside Pi
- making every worker independently user-facing
- supporting cloud/browser-hosted worker execution in v1
- solving overlapping parallel write conflicts automatically in v1
- mirroring oh-my-opencode-slim prompt text or role fiction

---

## Runtime topology

```text
User
  ↓
Main Pi session
  ↓
Orchestrator extension runtime
  ├─ Team manager
  ├─ Worker registry
  ├─ Prompt contracts
  ├─ UI/dashboard layer
  └─ RPC worker manager
       ├─ Worker: explorer
       ├─ Worker: librarian
       ├─ Worker: oracle
       ├─ Worker: designer
       ├─ Worker: fixer
       └─ Worker: reviewer/observer
```

### Main session

The main Pi session remains the session the user already sees in Pi interactive mode. The package changes its behavior through:

- system prompt augmentation/replacement for orchestrator mode
- custom tools for delegation and control
- extension event handlers and UI

### Worker sessions

Each worker is a separate child process:

```bash
pi --mode rpc --no-session [worker-specific options]
```

Each worker gets:

- isolated message history
- its own model and thinking level
- its own allowed tools
- a role-specific system prompt
- a controlled runtime configuration

---

## Session takeover mechanism

## Goal

Loading the package should make the current Pi session behave like the orchestrator by default.

## Mechanism

On extension startup:

1. load package config
2. load prompt contracts
3. register orchestration tools and commands
4. set active session behavior to orchestrator mode
5. install orchestrator-specific system prompt additions
6. expose worker dashboard/status UI

## Rules

- orchestrator mode is the default runtime mode of the main session when the extension is active
- workers are spawned only through the extension control plane
- worker sessions must not recursively assume orchestrator ownership

## Enforcement

The extension should implement a **launch policy** that distinguishes:

- `main-session = orchestrator session`
- `worker-session = subordinate specialist session`

Worker launches must pass explicit flags/config so they do not boot into full orchestrator mode again.

---

## Package layout

Proposed structure:

```text
package.json
README.md
extensions/
  pi-agent-team/
    index.ts
src/
  config.ts
  types.ts
  control-plane/
    team-manager.ts
    task-registry.ts
    persistence.ts
  runtime/
    worker-process.ts
    rpc-client.ts
    worker-manager.ts
    event-normalizer.ts
  profiles/
    loader.ts
    default-profiles.ts
  prompts/
    contracts.ts
  comms/
    agent-messaging.ts
    relay-queue.ts
    ping.ts
    summary.ts
  safety/
    launch-policy.ts
    path-scope.ts
  ui/
    status-widget.ts
    dashboard.ts
    overlay.ts
  commands/
    team.ts
    agents.ts
    steer.ts
    followup.ts
    cancel.ts
prompts/
  orchestrator.md
  agents/
    explorer.md
    librarian.md
    oracle.md
    designer.md
    fixer.md
    reviewer.md
    observer.md
docs/
  architecture.md
  prompting.md
  operations.md
  profiles.md
tests/
  runtime/
  control-plane/
  profiles/
  prompts/
  integration/
scripts/
  smoke/
```

---

## Control plane

The control plane lives inside the main extension runtime.

## Responsibilities

- spawn workers
- track worker/task lifecycle
- keep worker summaries compact
- expose tools/commands to the orchestrator
- expose UI to the operator
- persist recoverable orchestration state
- route worker relay messages back to orchestrator

## Main components

### `team-manager`
Top-level coordinator for:

- worker launch
- state transitions
- lookup by task ID / worker ID
- summary updates
- operator commands

### `task-registry`
Tracks:

- delegated task ID
- worker profile
- worker process/session handle
- status
- last update time
- current tool
- latest compact summary
- pending relay questions
- cancellation state

### `persistence`
Stores only recoverable orchestration metadata, for example:

- worker registry
- task metadata
- summaries
- relay messages
- profile references

It must **not** dump full worker transcripts into the orchestrator context.

---

## Worker runtime model

Each worker is a child Pi RPC process managed by the worker manager.

## Worker states

```text
created → starting → idle → running → waiting_followup → completed
                         ↘ error / aborted / exited
```

## Worker identity

Each worker record should include:

- `workerId`
- `taskId`
- `profileName`
- `processId`
- `rpcSessionState`
- `status`
- `startedAt`
- `lastEventAt`
- `currentTaskSummary`
- `lastCompactSummary`
- `lastToolName?`
- `relayQueue[]`

## Worker launch inputs

Each worker launch should specify:

- profile name
- initial task
- cwd
- model override if needed
- thinking level override if needed
- allowed tools set
- prompt file / prompt contract ID
- extension loading mode
- path scope / ownership constraints

---

## RPC worker wrapper

## Why RPC

Pi RPC mode is the right backend for this project because it supports:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `get_messages`
- `get_session_stats`

That is enough for long-lived, controllable workers.

## Wrapper responsibilities

### `worker-process`
Responsible for:

- spawning `pi --mode rpc`
- stdout/stderr management
- process lifecycle
- shutdown/kill behavior
- reconnect/failure reporting

### `rpc-client`
Responsible for:

- strict LF-delimited JSONL framing
- request/response correlation
- event subscription
- command dispatch
- transport-level timeouts

### `event-normalizer`
Responsible for turning raw RPC events into internal normalized worker events, for example:

- `worker_started`
- `worker_running`
- `worker_text_delta`
- `worker_tool_started`
- `worker_tool_finished`
- `worker_idle`
- `worker_error`

### `worker-manager`
Responsible for orchestrating many workers at once and exposing a clean API to the extension.

## Internal API

Proposed worker manager API:

```ts
launchWorker(profile, task, options) -> WorkerHandle
sendPrompt(workerId, message)
steerWorker(workerId, message)
followUpWorker(workerId, message)
pingWorker(workerId, mode)
cancelWorker(workerId)
getWorkerState(workerId)
getWorkerSummary(workerId)
listWorkers()
```

---

## Message flow

## 1. User request

```text
User → Orchestrator
```

The orchestrator decides:

- answer directly
- investigate itself
- delegate to one worker
- delegate to multiple workers

## 2. Delegation

```text
Orchestrator → Control plane → Worker manager → RPC worker
```

The delegated task should include:

- the goal
- minimal relevant context
- file/path hints
- expected output contract
- constraints

Not raw huge conversation dumps.

## 3. Worker execution

Workers do bounded work and emit:

- progress signals
- tool activity
- compact summaries
- relay questions when needed

## 4. Return path

```text
Worker → RPC events/results → Control plane → Orchestrator
```

The orchestrator receives:

- compact summary
- result payload
- status
- optional relay question

The orchestrator then decides what to do next.

---

## Communication model

## Steer

Used when a worker is currently running and the orchestrator/operator wants to alter direction without waiting for full completion.

Examples:

- “Stop searching docs, inspect the local code instead.”
- “Focus only on auth routes.”
- “Return a shorter summary and stop.”

Backend:
- Pi RPC `steer`

## Follow-up

Used when a worker is idle or the new instruction should be queued after the current run completes.

Examples:

- “Now also verify tests.”
- “After that, summarize migration risk.”

Backend:
- Pi RPC `follow_up`

## Ping

Two modes:

### Passive ping
No new model call. Returns cached information:

- current state
- last tool
- last event time
- queued relays
- last summary
- token/cost stats if known

### Active ping
Makes a deliberate worker request for a one-line current status.

Use only when explicitly requested or when passive status is insufficient.

## Relay questions

Workers must not block waiting for user answers.

Instead they emit a relay to the orchestrator, containing:

- question
- assumption made
- urgency
- recommended choices if available

This is the Pi Agent Team equivalent of `ask_orchestrator`, but implemented in a Pi-native way.

---

## Prompt contract format

## Principle

Prompts must be **informed by** the delegation logic observed in oh-my-opencode-slim, but must be **rewritten as Pi-native contracts**.

We are reusing:

- role separation
- delegation heuristics
- specialist boundaries
- cost/quality judgment
- compact reporting principles

We are not copying:

- wording
- prose structure
- branding
- character flavor text
- prompt text line-for-line

## Orchestrator prompt responsibilities

The orchestrator prompt should define:

- sole ownership of user dialogue
- when to delegate vs act directly
- how to choose the right worker
- how to keep worker context isolated
- how to request compact outputs
- when to steer / follow-up / ping
- how to resolve relay questions
- how to integrate worker results into one user-facing response

## Worker prompt responsibilities

Each worker prompt should define:

- its specialization boundary
- what inputs it expects from orchestrator
- what tools it may use
- what not to do
- how to produce compact summaries
- when to escalate to orchestrator
- that it should not address the user directly

## Output contract

Every worker prompt should define a predictable result shape, for example:

- `goal`
- `findings`
- `changed_files` or `read_files`
- `risks`
- `next_recommendation`
- `relay_question?`

Exact formatting can vary, but it must be compact and machine-friendly enough for the control plane to summarize.

---

## Specialist roles

Initial Pi-native worker set:

### Explorer
Use for:

- codebase discovery
- locating files/symbols/patterns
- broad reconnaissance

Returns:
- what exists
- where it is
- what seems relevant
- suggested next worker if needed

### Librarian
Use for:

- external docs
- API references
- version-sensitive framework/library guidance

Returns:
- authoritative docs findings
- relevant usage patterns
- caveats/version notes

### Oracle
Use for:

- architecture trade-offs
- complex debugging
- code review / simplification review
- high-risk decisions

Returns:
- decision recommendation
- rationale
- key risks
- review findings

### Designer
Use for:

- UI/UX implementation guidance
- polish and interface review
- visual interaction work

Returns:
- UI recommendations
- component/workflow guidance
- implementation priorities

### Fixer
Use for:

- bounded implementation
- routine code changes
- tests and targeted execution work

Returns:
- what changed
- verification results
- any blockers or follow-up suggestions

### Reviewer / Observer
Depending on implementation split:

- `reviewer` for validation/review lanes
- `observer` for screenshots/PDFs/images and other visual assets

---

## Safety model

## 1. Recursion prevention

Workers must not recursively boot the same orchestration runtime unless explicitly allowed for a future advanced mode.

Default rule:

- main session = orchestrator extension enabled
- worker session = orchestrator extension disabled or worker-minimal mode enabled

## 2. Tool restriction

Each profile gets an allowlist of tools.

Examples:

- explorer: read/search-heavy
- librarian: research/browser/docs heavy
- fixer: coding tools allowed within scope
- oracle: read/reason/review heavy

## 3. Path-scope ownership

Write-capable workers should be constrained by file/domain ownership wherever possible.

Examples:

- one fixer owns `src/auth/**`
- another fixer owns `src/ui/**`

This does not fully solve parallel edits, but it reduces collisions.

## 4. Transcript containment

Raw worker transcripts should stay outside the orchestrator context unless explicitly requested.

Default persisted artifacts:

- compact summaries
- final result blocks
- relay messages
- stats/status

---

## UI architecture

## Compact always-on UI

Using Pi extension UI primitives:

- footer status for overall team health
- widget for active worker list

The compact view should show:

- worker name
- state
- last update age
- current task or tool
- relay count
- short summary snippet

## Detailed UI

An overlay/dashboard should show:

- active workers
- delegated tasks
- last summaries
- recent relays
- worker stats
- selected worker details

This is for supervision, not for turning workers into user-facing chat agents.

---

## Persistence model

Persist:

- worker/task registry
- profile assignments
- compact summaries
- relay questions/assumptions
- timestamps and statuses

Do not persist by default into orchestrator context:

- full worker message history
- raw streaming deltas
- entire tool outputs

If needed, store transcript references separately for debugging.

---

## Failure handling

## Worker process failure

If a worker exits unexpectedly:

- mark worker as failed
- capture stderr and last event
- notify orchestrator
- allow orchestrator to relaunch or reroute work

## RPC parse/protocol failure

If JSONL parsing fails:

- terminate that worker
- mark protocol error
- preserve evidence for debugging
- avoid poisoning the rest of the team runtime

## Orchestrator reload/session restore

On reload or resume:

- restore the registry
- mark any missing live processes as exited/stale
- keep summaries and task state
- require explicit relaunch rather than pretending workers are still live

---

## Install and startup flow

## Install

The user installs the Pi Agent Team package.

## Load

Pi loads the extension from the package.

## Activate

On extension activation:

1. orchestrator prompt contract is applied to the main session
2. orchestration tools and commands are registered
3. worker manager is initialized
4. UI widgets/status are activated
5. profiles and safety policies are loaded

## Run

From that point onward, the visible session behaves as the orchestrator.

---

## Verification plan

Minimum acceptance checks:

1. **Install smoke**
   - package installs and loads in Pi
2. **Session takeover smoke**
   - main session is clearly in orchestrator mode
3. **Worker launch smoke**
   - orchestrator spawns a worker via RPC
4. **Steer smoke**
   - orchestrator/operator steers a running worker
5. **Follow-up smoke**
   - orchestrator queues a follow-up for a worker
6. **Ping smoke**
   - passive ping works, optional active ping works
7. **Relay smoke**
   - worker reports a question/assumption to orchestrator
8. **Prompt fixture tests**
   - orchestrator stays user-facing
   - worker stays subordinate
   - delegation logic follows intended role boundaries

---

## Open questions for implementation

These do not block the architecture, but need concrete choices during implementation:

1. should worker sessions load zero extensions, or a minimal worker-only helper extension?
2. should active ping be implemented as a dedicated command flow or just another prompt contract?
3. should reviewer and observer be one role or two separate profiles in v1?
4. what is the minimal structured result schema shared by all workers?
5. how much worker transcript retention should be available for debugging without leaking into orchestrator context?

---

## Summary

Pi Agent Team is an **orchestrator-first package**, not a multi-chat bot switcher.

The correct mental model is:

- **one visible orchestrator session**
- **many subordinate RPC worker sessions**
- **compact worker outputs**
- **live steering and supervision**
- **orchestrator owns the user relationship**

That is the core runtime architecture the implementation should preserve.