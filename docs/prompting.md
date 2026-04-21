# Prompt contracts

Pi Agents Team uses Pi-native prompt contracts for the orchestrator and each worker role. Contracts are opinionated: they define what each role owns, how workers report back, and what the orchestrator must do while workers are running.

## Design principle

These prompts reuse delegation ideas (role separation, compact reporting, escalation, bounded specialist work) but do not copy prompt text, branding, or persona flavor from other systems.

The package goal stays simple:

- one visible orchestrator session
- many subordinate RPC workers
- compact worker outputs
- explicit supervision through steer, follow-up, ping, relay, and result tools

## Orchestrator contract

Full text: [`../prompts/orchestrator.md`](../prompts/orchestrator.md). Key commitments:

### Identity

The orchestrator is the only agent that speaks to the user. Workers are background specialists under its supervision.

### Delegate by default

Any investigation, mapping, review, multi-file change, or context-hungry task belongs to a worker. The orchestrator only works directly on trivial single-step asks or cheap operator commands.

When the user asks for N workers or parallel analysis, the orchestrator spawns them immediately in one batch, each with its own focused slice. It does not pre-explore the repo to "figure out what to delegate."

### Profiles vs skills

`delegate_task.profileName` must be one of the seven team profiles (`explorer`, `librarian`, `oracle`, `designer`, `fixer`, `reviewer`, `observer`). These are the worker roles shipped by this extension.

Pi skills (the `[Skills]` list shown in the Pi startup banner — e.g. `writer`, `frontend-design`, `architecting-systems`) are host-level capabilities, not profiles. To have a worker load one during its task, pass the names through the optional `delegate_task.skills` array. The worker task prompt injects an explicit instruction to invoke each listed skill via its Skill tool before emitting the `<final_answer>`. Omit `skills` when no specialized skill is needed — that's the correct default for most delegations. Never pass a skill name as `profileName` (it fails with `Unknown team profile: <name>`).

### Wait, don't poll

The loop after `delegate_task`:

1. Call `wait_for_agents` with the new worker ids. Zero tokens while waiting. Returns on one of four reasons:
   - `all_terminal`: every target reached a terminal status (`idle`, `completed`, `aborted`, `error`, `exited`).
   - `relay_raised`: at least one running worker raised a new relay question; other targets may still be running.
   - `timeout`: default 5 min elapsed.
   - `aborted`: the wait was cancelled.
2. If `reason === "relay_raised"`, read `details.newRelays` (each entry has `workerId`, `profileName`, `question`, `urgency`), answer each via `agent_message` (auto-routed), then call `wait_for_agents` again with the same ids to go back to sleep. Do **not** wait for every worker to finish before answering a mid-flight relay.
3. If `reason === "all_terminal"`, call `agent_result` once per worker and synthesize.

The wait resumes cleanly because `waitForTerminal` re-snapshots each target's pending-relay count on every call. Already-answered relays don't wake it again; only new ones do.

Forbidden: looping `ping_agents`, sleeping in bash, spawning new workers to "check on" old ones, running bash/read/grep directly to "help" a running worker, treating `interim=…` text in a running worker as a finding.

### Reading status

- `running` means not done. `interim=` text is a streaming fragment, not a result.
- A worker is done only when its status is `idle`, `completed`, `exited`, `aborted`, or `error`.
- A worker with `status=idle` and an empty `<final_answer>` is "ran but produced no output." Re-delegate, steer, or cancel, don't pretend it succeeded.

### Worker toasts are UI-only

When workers reach a terminal state, the extension shows transient toasts (`✓ N workers finished: w1, w2…`). These are not part of the orchestrator's conversation. The orchestrator must not reply to them or re-call `agent_result` after it already has the summary.

## Worker contracts

Every worker prompt (see `prompts/agents/*.md`) assumes:

- it is subordinate to the orchestrator
- it does not speak to the user directly
- it keeps output compact and structured
- it raises a relay question with an assumption rather than blocking forever
- it wraps its final deliverable in a single `<final_answer>…</final_answer>` block

### Result shape

Each role uses short, machine-friendly fields:

- `goal`
- `findings` or `changed_files`
- `risks`
- `next_recommendation`
- `relay_question` plus `assumption` **only when** orchestrator input is genuinely needed

Exact field names vary by role. The compact-reporting principle stays the same.

### Placeholder relays are filtered

Workers must **omit** `relay_question` entirely when they have nothing to ask. `extractRelayQuestions` treats values like `none`, `no`, `n/a`, `not needed`, `-`, `—`, `null`, `undefined` (case-insensitive, trailing punctuation stripped) as "no relay" and drops them. Writing `relay_question: none` is not a way to signal "no question"; it just gets ignored. The extension's relay toast also refuses to fire for empty/whitespace-only questions as a second line of defense.

## The `<final_answer>` contract

Every delegated task prompt (`buildWorkerTaskPrompt` in `src/prompts/contracts.ts`) tells the worker that its final assistant message must wrap the complete deliverable in a single `<final_answer>…</final_answer>` block.

Example:

```text
<final_answer>
headline: one-sentence summary of the outcome

findings:
- bullet 1
- bullet 2

files:
- path/one.ts
- path/two.ts

risks:
- edge case worth flagging

next_recommendation:
- what to do next
</final_answer>
```

### Why a hard block

- **One authoritative surface.** `agent_result` returns the block verbatim. The orchestrator never has to scrape transcripts.
- **Compact state stays honest.** Contents outside the block are internal notes and are not forwarded, which keeps orchestrator context small.
- **Failure is explicit.** An empty block is a clear signal the worker did not follow the contract; the orchestrator's response is to re-delegate, steer, or cancel, not to fall back to doing the work itself.

### What the runtime does

`extractFinalAnswer` pulls the block from the worker's final assistant message and stores it on `WorkerRuntimeState.finalAnswer`. `agent_result` and `/agent-result` both render it under a `--- Final answer ---` section. If the block is missing, the output explicitly says so and tells the caller to re-delegate or steer.

## Current worker set

- `explorer`
- `librarian`
- `oracle`
- `designer`
- `fixer`
- `reviewer`
- `observer`

Prompt files live under [`../prompts/agents/`](../prompts/agents/) and are loaded by `src/prompts/contracts.ts`. The orchestrator prompt is at [`../prompts/orchestrator.md`](../prompts/orchestrator.md).

## Prompt path resolution

Worker prompt lookup follows the active runtime config, not the packaged profile loader alone:

1. explicit `delegate_task.systemPromptPath` if provided
2. otherwise the resolved role `promptPath` from the active config
3. packaged prompt path from the built-in role when no project override is active

When a session-frozen project config is active, both project prompt overrides and explicit launch-time `systemPromptPath` values must stay within the discovered project root.

## Injection point

On `before_agent_start`, the extension replaces the orchestrator session's system prompt with `${originalSystemPrompt}\n\n${buildOrchestratorPromptBundle(state, config)}`. The bundle concatenates the markdown contract with a live status header (active worker count, relay count, transport, safety flags, available profiles). Worker prompts are loaded via `systemPromptPath` at launch time.
