# Profiles / Roles

Pi Agents Team ships with seven default worker profiles. Under **schema v2** (current), the user's `agents-team.json` fully owns the role list — you can keep the seven defaults, rename them, drop unused ones, or add your own. There is no concept of a built-in "ceiling" that user roles must stay below; the file you write is the source of truth.

## Seven default profiles (built-in scaffold starting point)

| Profile | Best for | Tools | Thinking | Write |
|---|---|---|---|---|
| `explorer` | Fast codebase reconnaissance and file discovery | `read`, `grep`, `find`, `ls`, `bash` | low | read-only |
| `librarian` | Docs, APIs, and version-sensitive reference research | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `oracle` | Architecture, debugging, and review-heavy judgement | `read`, `grep`, `find`, `ls`, `bash` | high | read-only |
| `designer` | UI and interaction design guidance | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `reviewer` | Validation, critique, and regression review | `read`, `grep`, `find`, `ls`, `bash` | medium | read-only |
| `observer` | Observation for screenshots or non-code artifacts | `read`, `grep`, `find`, `ls`, `bash` | low | read-only |
| `fixer` | Bounded implementation, tests, and targeted edits | `read`, `bash`, `edit`, `write` | medium | write |

When no `agents-team.json` is present, these seven are what the orchestrator sees. `/team-init <scope>` writes this list as a starting scaffold you can edit.

## `agents-team.json` schema (v2)

**Layering precedence:**

1. Project file at `<cwd-or-ancestor>/.pi/agent/agents-team.json` → used if present and valid.
2. Else global file at `~/.pi/agent/agents-team.json` → used if present and valid.
3. Else the built-in seven profiles.

Project **fully replaces** global when both exist — there's no cross-layer merging. If a role exists in global but you want it in a project, copy the block over.

**Top-level shape:**

```json
{
  "schemaVersion": 3,
  "scaffoldVersion": 3,
  "enabled": true,
  "roles": { "<role-name>": { /* RoleConfig */ } }
}
```

- `schemaVersion: 3` is the current schema contract. A file with any other number (or the legacy `version` field) triggers a session-start warning toast and falls back to the built-in roles for that layer — run `/team-init <scope> --force` to regenerate (old file is backed up first).
- `scaffoldVersion` is a freshness marker for the scaffold contents. It's softer — it just flags files produced by older `/team-init` runs so you can re-init when default best practices shift.
- `enabled: false` puts the extension in dormant mode (tools refuse, UI clears, orchestrator prompt is not injected). Toggle with `/team-enable`/`/team-disable`.

**Per-role fields** (all optional — omit to get the default):

- `whenToUse` (string): a **trigger sentence** shown to the orchestrator LLM in the **Available worker profiles** block. Write it as `"Use for / when / to ..."` so the orchestrator can match it against incoming user requests. The legacy alias `description` is accepted for backcompat; `whenToUse` wins when both are present. Examples that work well:
  - `"Use for fast codebase reconnaissance. Best for 'where is X?' and 'how does Y work?' questions."`
  - `"Use when the user wants a list of API routes that touch src/api."`
  - `"Use for bounded code changes — implement a specific fix or add a test. Requires a pathScope at delegate time. Write-capable."`
  Avoid passive descriptions like `"A code explorer."` — they don't give the orchestrator a clear delegation trigger.
- `model` (string): `"default"` (or omit) inherits the orchestrator's current model. Any other value pins a model ID (e.g. `"anthropic/claude-opus-4-7"`).
- `thinkingLevel` (string): one of `off | minimal | low | medium | high | xhigh`. Default `medium`.
- `tools` (string[]): the tool set the worker can use. No ceiling — whatever you declare is what the worker gets. Default `["read", "grep", "find", "ls", "bash"]` when omitted.
- `write` (boolean): `true` allows edit/write (requires a `pathScope` at delegate time, enforced by launch-policy); `false` forces read-only. Default `false`.
- `prompt` (string): three forms —
  - `"default"` (or omit): use the packaged prompt at `prompts/agents/<role-name>.md` if the role name matches one of the seven built-ins; otherwise use the generic worker template (`prompts/agents/_generic-worker.md`) with the role's name + `whenToUse` substituted in.
  - `"some/path.md"`: load the worker prompt from that file. Resolved relative to the config file's directory (for project configs, must stay inside the project root).
  - Any other string: treated as **inline prompt text**. The exact string becomes the worker's role prompt. Useful when you don't want to create a separate markdown file — `"prompt": "You are a tiny agent that only lists paths matching a regex. Do nothing else."` works.
- `advanced` (object, power-user only, not emitted by `/team-init`): `extensionMode` (`"worker-minimal"` | `"disable"`; `"inherit"` is rejected as a recursion risk), `canSpawnWorkers` (boolean, default `false`), `pathScope` (a `{ roots, allowReadOutsideRoots, allowWrite }` block for path-level sandboxing).

## Launch-time safety (still enforced)

The loader trusts your JSON for role shape, but `launch-policy.ts` still enforces two platform-level invariants every time `delegate_task` fires:

1. **No recursive orchestrators.** If a role declares `advanced.extensionMode: "inherit"` or a caller tries to pass it at launch time, the launch is rejected.
2. **Writable roles need a path scope.** If `write: true` and no `pathScope` is provided (either in `advanced.pathScope` or as `pathScopeRoots` on the `delegate_task` call), the launch is rejected. This prevents "write anywhere" workers by default.

Launch-time overrides may only narrow the role's declared rights (fewer tools, narrower path scope, etc.); they cannot broaden them.

## Scaffold example

`/team-init local` writes this in `.pi/agent/agents-team.json`:

```json
{
  "schemaVersion": 3,
  "scaffoldVersion": 3,
  "enabled": true,
  "roles": {
    "explorer": {
      "description": "Fast codebase reconnaissance and file discovery.",
      "model": "default",
      "thinkingLevel": "low",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "write": false,
      "prompt": "default"
    },
    "fixer": {
      "description": "Bounded implementation, tests, and targeted edits.",
      "model": "default",
      "thinkingLevel": "medium",
      "tools": ["read", "bash", "edit", "write"],
      "write": true,
      "prompt": "default"
    }
    /* ... 5 more roles ... */
  }
}
```

Edit it freely — rename roles, drop ones you don't need, add new ones. The orchestrator sees exactly what you declared.

## Custom-role example (add a new role from scratch)

```json
{
  "schemaVersion": 3,
  "scaffoldVersion": 3,
  "enabled": true,
  "roles": {
    "api-scout": {
      "description": "Recon specifically inside src/api. Use for quick questions about request handlers and routes.",
      "thinkingLevel": "low",
      "tools": ["read", "grep", "find", "ls"],
      "write": false,
      "prompt": "You are an API-focused recon agent. Only inspect src/api. Return matching file paths and one-line notes per finding. No other commentary."
    }
  }
}
```

The `"prompt"` string here doesn't resolve to a file, so it's used as inline text. The orchestrator sees `api-scout` as an available profile with the given description and can pass `profileName: "api-scout"` to `delegate_task`.

## Init + toggle commands

- `/team-init global` → scaffolds `~/.pi/agent/agents-team.json` with the seven built-ins.
- `/team-init local` → same, in `<cwd>/.pi/agent/agents-team.json`.
- Neither command overwrites an existing file. Pass `--force` to replace — the old file is renamed to `YYYY-MM-DD-HHMM-agents-team.json` in the same directory first.
- `/team-enable global|local` → sets `enabled: true` (creates the file with just the flag if missing). `/reload-plugins` to apply.
- `/team-disable global|local` → sets `enabled: false`.

## Prompt resolution reference

| `"prompt"` value | Role name | Result |
|---|---|---|
| omitted / `"default"` | matches a built-in (fixer, explorer, ...) | packaged `prompts/agents/<name>.md` |
| omitted / `"default"` | custom (e.g. `api-scout`) | generic worker template with `{NAME}` + `{DESCRIPTION}` substituted |
| path that resolves to a readable file | any | that file's contents |
| path that escapes project root (project config only) | any | **error** — layer invalid, delegation disabled until fixed |
| any other string | any | inline prompt text (stored on the profile, served verbatim) |

## Customizing packaged prompt files

The seven packaged prompts live at [`../prompts/agents/*.md`](../prompts/agents/). You can edit them directly, but changes are global to your install. Prefer scoping via `prompt: "path/to/your.md"` or inline in `agents-team.json` for per-repo customizations.

See [`prompting.md`](prompting.md) for the `<final_answer>` contract that every worker prompt must uphold.
