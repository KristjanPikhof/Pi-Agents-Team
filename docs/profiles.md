# Profiles

Pi Agents Team ships with seven default worker profiles. Each one is a combination of role prompt, default tools, thinking level, extension mode, and write policy.

## Default profiles

| Profile | Best for | Tools | Thinking | Write policy |
|---|---|---|---|---|
| `explorer` | Fast codebase reconnaissance and file discovery | `read`, `grep`, `find`, `ls`, `bash` | low | read-only |
| `librarian` | Docs, APIs, and version-sensitive reference research | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `oracle` | Architecture, debugging, and review-heavy judgement | `read`, `grep`, `find`, `ls`, `bash` | high | read-only |
| `designer` | UI and interaction design guidance | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `reviewer` | Validation, critique, and regression review | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `observer` | Observation for screenshots or non-code artifacts | `read`, `grep`, `find`, `ls`, `bash` | low | read-only |
| `fixer` | Bounded implementation, tests, and targeted edits | `read`, `bash`, `edit`, `write` | medium | scoped-write |

All profiles default to `extensionMode: worker-minimal` and `canSpawnWorkers: false`.

## Where profiles live

Packaged profiles live in [`../profiles/`](../profiles/). The loader reads the markdown frontmatter and resolves:

- `name`
- `description`
- `model` (optional; inherits the orchestrator's model when omitted)
- `thinkingLevel`
- `tools`
- `promptPath`
- `extensionMode`
- `writePolicy`
- `canSpawnWorkers`

The full profile spec is defined by `TeamProfileSpecSchema` in `src/config.ts`.

## Launch policy

Launch policy (`src/safety/launch-policy.ts`) runs for every `delegate_task` and resolves:

1. **Extension mode.** Defaults to the profile's mode (`worker-minimal`). If `preventRecursiveOrchestrator` is on (default) and the caller tries `inherit`, it throws.
2. **Path scope.** For `scoped-write` profiles, `ensureWriteScope` requires explicit writable roots. Read-only profiles go through `normalizePathScope`, which permits broad inspection without granting write capability.
3. **Model, thinking level, tools, prompt path.** The caller can override; the profile is the default.

## Safety rules

### No recursive orchestrators

Workers launch with `worker-minimal`, which disables extension discovery inside the worker. That stops a worker from re-instantiating the full orchestrator package and from spawning its own subordinate workers through this extension. `canSpawnWorkers` on the default profiles is `false` to match.

### Scoped write policy

`fixer` is intentionally stricter. If you launch a write-capable worker without a writable path scope, launch policy rejects the task. This is the simplest guardrail against two workers stepping on the same files.

If you need writes, pass `pathScopeRoots` and set `pathScopeAllowWrite: true` on the `delegate_task` call (or bake the scope into the profile spec).

### Read-only profiles stay simple

Read-only profiles can inspect broadly and summarize findings. They do not need writable scopes and will not block on their absence.

## Customizing profiles

Edit or replace the markdown files in `profiles/`. Each file uses frontmatter like this:

```yaml
---
name: fixer
description: Bounded implementation, tests, and targeted edits
model: claude-sonnet-4-5
thinking: medium
tools: read, bash, edit, write
prompt: prompts/agents/fixer.md
extensionMode: worker-minimal
writePolicy: scoped-write
canSpawnWorkers: false
---
```

If you rename a profile or its prompt file, keep the spec and the file in [`../prompts/agents/`](../prompts/agents/) aligned. Tests in `tests/profiles/loader.test.ts` and `tests/prompts/prompt-files.test.ts` will fail fast if they drift.

## Profile prompt contract

Every role prompt in `prompts/agents/*.md` has the same shape:

- mission statement
- working-style rules (stay in scope, verify, report compactly)
- result shape (goal, findings/changed_files, risks, next_recommendation)
- `<final_answer>…</final_answer>` block contract in the final assistant message

See [`prompting.md`](prompting.md) for the full contract and why it matters.
