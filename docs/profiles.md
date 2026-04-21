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

1. **Extension mode.** Defaults to the profile's mode (`worker-minimal`). If `preventRecursiveOrchestrator` is on (default) and the caller tries `inherit`, it throws. Launch-time overrides may only keep or narrow the role's configured extension mode.
2. **Path scope.** For `scoped-write` profiles, `ensureWriteScope` requires explicit writable roots. If a role already has a configured scope, launch-time overrides may only narrow it. When a session-frozen `agents-team.json` is active, prompt paths and path-scope roots must stay inside the discovered project root.
3. **Model, thinking level, tools, prompt path.** The caller can override model and thinking level. Tool overrides may only remove capabilities from the role's configured tool set; they cannot add new rights.

## Safety rules

### No recursive orchestrators

Workers launch with `worker-minimal`, which disables extension discovery inside the worker. That stops a worker from re-instantiating the full orchestrator package and from spawning its own subordinate workers through this extension. `canSpawnWorkers` on the default profiles is `false` to match.

### Scoped write policy

`fixer` is intentionally stricter. If you launch a write-capable worker without a writable path scope, launch policy rejects the task. This is the simplest guardrail against two workers stepping on the same files.

If you need writes, pass `pathScopeRoots` and set `pathScopeAllowWrite: true` on the `delegate_task` call (or bake the scope into the profile spec).

### Read-only profiles stay simple

Read-only profiles can inspect broadly and summarize findings. They do not need writable scopes and will not block on their absence.

Project role overrides and launch-time overrides may narrow a read-only role, but they cannot turn it into a write-capable role. In practice that means read-only roles cannot gain `edit`/`write`, cannot switch to `scoped-write`, and cannot declare writable path scopes.

## Config handoff (`agents-team.json`)

The extension reads **two optional** config files and layers them on top of the built-in role defaults:

- **Global**: `~/.pi/agent/agents-team.json` — user-level defaults shared across projects.
- **Project**: `<project>/.pi/agent/agents-team.json` — nearest ancestor of the current working directory wins.

Both files follow the same schema. Either may be absent. Use `/team-init global` or `/team-init local` to write a minimal skeleton in the right spot.

### Resolution order

```
built-in role defaults
  → global agents-team.json      (optional)
    → project agents-team.json    (optional)
      → launch-time overrides on delegate_task
```

Each layer may only **narrow** what the previous layer allowed — it can drop tools, shrink `pathScope` roots, switch `scoped-write` to `read-only`, etc. A layer cannot re-grant rights a prior layer removed.

### Enabled flag

The top-level optional `enabled: boolean` controls whether the orchestrator logic is active at all. Precedence: **project > global > default `true`**. When resolved `enabled` is `false`:

- The extension stays loaded but session_start shows a one-line toast naming the source file and telling the operator how to re-enable (`/team-enable global|local` then `/reload-plugins`).
- The "Pi Agents Team loaded" banner is hidden.
- `delegate_task` and the other 6 tools refuse with the disabled message if called.
- The widget and status line are cleared; `before_agent_start` doesn't inject the orchestrator prompt bundle. Pi behaves as a plain session.
- `/team-init`, `/team-enable`, and `/team-disable` still work so you can flip the flag without editing JSON.

Use this to disable the team globally and re-enable only in specific projects (or the reverse). After flipping the flag, run `/reload-plugins` — a fresh session picks it up on next start.

### Init commands

- `/team-init global` → writes `~/.pi/agent/agents-team.json` with `{ version: 1, enabled: true, roles: {} }`.
- `/team-init local` → writes `<cwd>/.pi/agent/agents-team.json` (same skeleton).
- Neither command overwrites an existing file. Pass `--force` to replace the current contents.

### Toggle commands

- `/team-enable global|local` → sets `enabled: true`.
- `/team-disable global|local` → sets `enabled: false`.

Both create the file if it's missing. If the existing file is unreadable/invalid JSON, the toggle command writes a minimal replacement and prints a warning. Always follow with `/reload-plugins` to apply the change in the current Pi session.

### Discovery and session-freezing

- **Nearest-ancestor wins** for the project layer (walks up from cwd).
- Once session_start fires, the resolved config is frozen for that session. Editing the file later does not hot-swap state — `/reload-plugins` re-reads both layers.
- **Path sandbox**: project prompt paths and writable scope roots must resolve inside the project root (the directory holding `.pi/agent/agents-team.json`). Global paths may be absolute.
- **Invalid config behavior**: parse errors, schema errors, missing project prompt files, escaping paths, or any rights-broadening error flip the config status to `invalid`. The built-in role config stays in memory for inspection, but delegation is disabled until you fix the file.

### Precedence rules

The effective worker launch config resolves in this order:

1. **Built-in role defaults** from `profiles/` + `src/config.ts`
2. **Project role overrides** from `agents-team.json` for the matching role
3. **Launch-time narrowing overrides** on `delegate_task`

Within that, specific fields resolve as follows:

- **Model:** `delegate_task.model` → role model from active config → orchestrator model → Pi default
- **Prompt path:** explicit `delegate_task.systemPromptPath` (must stay inside project root when project config is active) → role `promptPath` from the active config
- **Tools / extension mode / write policy / path scope / worker spawning:** may only stay the same or get narrower than the active role config; they never widen at runtime

### Rights ceilings

Project configs are allowed to customize a role, but they cannot exceed the built-in role's ceiling:

- cannot add tools the built-in role does not already have
- cannot upgrade `read-only` to `scoped-write`
- cannot declare writable path scopes for read-only roles
- cannot broaden a default path scope
- cannot broaden extension mode rights (`inherit` is forbidden here)
- cannot flip `canSpawnWorkers` from `false` to `true`

Launch-time overrides are stricter again: they can only narrow the already-resolved active role.

### Full built-in role skeleton

This is the minimal shape for a complete project config file. Omitted optional fields inherit from the built-in role; the file must still include every built-in role key.

```json
{
  "version": 1,
  "roles": {
    "explorer": {
      "description": null,
      "model": null,
      "thinkingLevel": "low",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "librarian": {
      "description": null,
      "model": null,
      "thinkingLevel": "medium",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "oracle": {
      "description": null,
      "model": null,
      "thinkingLevel": "high",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "designer": {
      "description": null,
      "model": null,
      "thinkingLevel": "medium",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "fixer": {
      "description": null,
      "model": null,
      "thinkingLevel": "medium",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "reviewer": {
      "description": null,
      "model": null,
      "thinkingLevel": "medium",
      "permissions": {},
      "prompt": { "source": "builtin" }
    },
    "observer": {
      "description": null,
      "model": null,
      "thinkingLevel": "low",
      "permissions": {},
      "prompt": { "source": "builtin" }
    }
  }
}
```

Example project prompt override + scoped fixer root:

```json
{
  "version": 1,
  "roles": {
    "explorer": { "permissions": {}, "prompt": { "source": "builtin" } },
    "librarian": { "permissions": {}, "prompt": { "source": "builtin" } },
    "oracle": { "permissions": {}, "prompt": { "source": "builtin" } },
    "designer": { "permissions": {}, "prompt": { "source": "builtin" } },
    "fixer": {
      "permissions": {
        "pathScope": {
          "roots": ["src/scoped"],
          "allowReadOutsideRoots": false,
          "allowWrite": true
        }
      },
      "prompt": { "source": "builtin" }
    },
    "reviewer": {
      "permissions": {},
      "prompt": { "source": "project", "path": "prompts/reviewer.md" }
    },
    "observer": { "permissions": {}, "prompt": { "source": "builtin" } }
  }
}
```

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
