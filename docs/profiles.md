# Roles (agents-team.json)

**TL;DR.** Pi Agents Team ships with seven default worker roles. Drop a file at `.pi/agent/agents-team.json` to customize them, add new ones, or cut the list down. The orchestrator only delegates to roles that exist in the loaded config, so the file is a direct knob on what your team of workers can do.

The fastest path: run `/team-init local` in a repo, edit the resulting file, run `/reload`. Done.

## When to reach for this

| Goal | What to do |
|---|---|
| Use the extension as-is with sensible defaults | Nothing. No config file needed. |
| Tune one role (e.g. pin a model for `oracle`) | `/team-init local`, edit that one role block, `/reload`. |
| Swap the default names for your own vocabulary | Edit the `roles` keys after `/team-init local`. |
| Build a repo-specific team from scratch | `/team-init local`, delete every role you don't want, add the ones you do. |
| Share a config with your team | Commit `.pi/agent/agents-team.json`. Teammates pick it up on next session start. |
| Apply the same config across every repo | Write `~/.pi/agent/agents-team.json` (or use `/team-init global`). |

## The seven defaults

These are what the orchestrator sees when no file is present. `/team-init` stamps them into the scaffold verbatim so you have a working starting point to edit.

| Role | When to use it | Tools | Thinking | Write |
|---|---|---|---|---|
| `explorer` | Fast reconnaissance. "Where is X?", "how does Y work?", "list files that touch Z." | `read`, `grep`, `find`, `ls`, `bash` | low | no |
| `librarian` | Library and docs research. "How do I use this dependency?", "what changed in vX.Y?" | `read`, `grep`, `find`, `ls`, `bash` | medium | no |
| `oracle` | Architecture judgment and root-cause work. Thinks slowly, answers carefully. | `read`, `grep`, `find`, `ls`, `bash` | high | no |
| `designer` | UI/UX critique, layout suggestions, design-system consistency. | `read`, `grep`, `find`, `ls`, `bash` | medium | no |
| `reviewer` | Validate a change, hunt regressions, confirm tests cover what they claim. | `read`, `grep`, `find`, `ls`, `bash` | medium | no |
| `observer` | Screenshots, images, non-code artifacts. | `read`, `grep`, `find`, `ls`, `bash` | low | no |
| `fixer` | Bounded code changes. Implement a fix, add a test, edit one file. | `read`, `bash`, `edit`, `write` | medium | yes |

Only `fixer` can write by default. Every write-capable role (that is, `access.write: true` OR `access.tools` containing `edit`/`write`) needs an explicit `pathScope` at delegate time. That's enforced by launch-policy, not by role config, so you can't accidentally un-safe it.

> **Path scope honesty.** `pathScope` is a prompt convention + delegate-time check, not an OS sandbox. Pi does not jail worker processes at the kernel level; `bash` in particular can execute arbitrary shell commands in the worker's cwd. Every built-in read-only role ships with `bash` because git/ls/grep workflows need it. If you include `bash` in a profile, you are trusting the orchestrator LLM + the role prompt to honor the scope. For stricter containment (untrusted configs, unfamiliar repos), stop delegating to write-capable profiles or drop `bash` from the role's tools. See [CLAUDE.md](../CLAUDE.md) "Path scope is a prompt convention" for the full rationale.

## Creating or editing roles

### Scaffold a starter file

```
/team-init local     → writes ./.pi/agent/agents-team.json
/team-init global    → writes ~/.pi/agent/agents-team.json
/team-init <scope> --force    → replace existing file (backs up the previous one first)
```

The scaffold contains all seven built-in roles in the current shape. Edit whatever you want.

### The shape, field by field

```json
{
  "schemaVersion": 4,
  "scaffoldVersion": 1,
  "enabled": true,
  "workerAccess": {
    "allowPathsOutsideProject": true
  },
  "roles": {
    "explorer": {
      "whenToUse": "Use for fast reconnaissance. Best for 'where is X?', 'how does Y work?', 'list files that touch Z.'",
      "model": "default",
      "thinkingLevel": "low",
      "access": {
        "tools": ["read", "grep", "find", "ls", "bash"],
        "write": false
      },
      "prompt": "default"
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Tells the loader which shape this file is. Currently `4`. A mismatch triggers a warning and falls back to built-ins for that layer. |
| `scaffoldVersion` | no | Freshness marker. Mismatched values just nudge you to re-run `/team-init --force` to pick up newer defaults. |
| `enabled` | no | `false` puts the extension in dormant mode (tools refuse, UI clears). Default `true`. |
| `workerAccess` | no | Global access policy for delegated workers. Omit to keep the defaults. |
| `roles.<name>` | no | Free-form map. Name whatever you want. No role entry means built-in fallback (or nothing, if you want no roles at all). |

### Top-level worker access fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `workerAccess.allowPathsOutsideProject` | boolean | `true` | Delegated worker `pathScope` roots may point outside the project root / current cwd by default. Set this explicitly to `false` to restrict scopes to the project root/current cwd. This does **not** affect the visible orchestrator, relax prompt-file containment, or create an OS sandbox. |

Example:

```json
{
  "schemaVersion": 4,
  "enabled": true,
  "workerAccess": {
    "allowPathsOutsideProject": false
  },
  "roles": {
    "fixer": {
      "prompt": "default"
    }
  }
}
```

With this restriction enabled, delegated worker path scopes must stay inside the repo/current cwd. If the field is omitted or set to `true`, the orchestrator can delegate a worker with a path scope like:

```json
["/tmp/my-log-dir", "src"]
```

without being forced to stay fully inside the repo root.

### Per-role fields

All optional. Omit to get the default.

| Field | Type | Default | Notes |
|---|---|---|---|
| `whenToUse` | string | `""` | The trigger sentence shown to the orchestrator LLM. Write it as `"Use for / when / to ..."` so the model can match it against user requests. |
| `model` | string | `"default"` | `"default"` inherits the orchestrator's current model. Otherwise a canonical Pi model ID in `<provider>/<model-id>` form (check `pi --help` or your Pi install's model list for exact names — available models are install-specific). |
| `thinkingLevel` | string | `"medium"` | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `access` | object | default read tools | Worker capabilities for this role. See "Per-role access fields" below. |
| `prompt` | string | `"default"` | See "Prompt resolution" below. |

### Per-role access fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `access.tools` | string[] | `["read", "grep", "find", "ls", "bash"]` | Tool set the worker can use. You declare it. No ceiling. |
| `access.write` | boolean | `false` | `true` allows `edit`/`write`. Requires a `pathScope` at delegate time (platform-level safety). |
| `access.pathScope` | object | omitted | Default path scope for this role. The orchestrator can also pass `pathScopeRoots` at delegate time. |
| `access.extensionMode` | string | `"worker-minimal"` | `"worker-minimal"` or `"disable"`. `"inherit"` is rejected to prevent recursive orchestrators. |
| `access.canSpawnWorkers` | boolean | `false` | Reserved for role metadata. Workers still run as background RPC peers, not nested user-facing agents. |

### Writing a good `whenToUse`

This one matters more than the others. The orchestrator picks roles by matching `whenToUse` sentences against whatever the user asked for, so the phrasing directly controls delegation quality.

```
Good:  "Use for root-cause analysis of intermittent bugs. Pick this over
        explorer when the user needs reasoning, not just code location."
Bad:   "An oracle-like role."
```

Lead with `Use for`, `Use when`, or `Use to`. Mention concrete trigger phrases the user might say. If two of your roles could both handle something, name the tiebreaker explicitly ("pick this over X when...").

### Prompt resolution

The `prompt` field has three forms. The loader picks one by checking what the string looks like on disk.

| You write | Role name | Result |
|---|---|---|
| `"default"` or omitted | matches a built-in (`fixer`, `explorer`, etc.) | Loads the packaged prompt at `prompts/agents/<name>.md`. |
| `"default"` or omitted | custom (e.g. `api-scout`) | Loads `prompts/agents/_generic-worker.md` and substitutes `{NAME}` + `{DESCRIPTION}` (the role's `whenToUse`). |
| Any string that resolves to a readable file | any | Loads that file's contents as the worker prompt. |
| Any string that does not resolve to a file, path-shaped (`./`, `~/`, `http(s)://`, ends in `.md`, contains `/` without whitespace) | any | Treated as inline prompt text, but emits a `project_prompt_missing` warning. The warning catches typos — `prompts/reviewr.md` silently becoming a 21-char inline prompt is worse than surfacing it. |
| Any string that does not resolve to a file, prose-shaped | any | Treated as inline prompt text, no warning. This is the explicit escape hatch for "I want to write the prompt inline." |
| Empty / whitespace-only string | any | Warning (`project_prompt_empty`), falls back to the generic worker template. |
| Path that escapes the project root (including symlinks whose realpath is outside the real project root) | any | Hard error (`project_path_escape`). Layer is marked invalid, delegation disabled until fixed. |

Inline text is the escape hatch when you don't want to maintain a separate markdown file:

```json
"api-scout": {
  "whenToUse": "Use when the user wants route/handler recon inside src/api.",
  "access": {
    "tools": ["read", "grep", "find"],
    "write": false
  },
  "prompt": "You are a scout that only inspects src/api. Return matching file paths and one-line notes per finding. No other commentary."
}
```

## Common recipes

### Pin a specific model for one role

```json
"oracle": {
  "model": "<provider>/<model-id>",
  "thinkingLevel": "xhigh"
}
```

Replace `<provider>/<model-id>` with an actual canonical Pi model ID (check your Pi install's available models — the exact set depends on configured providers).

Everything else (access, prompt) falls through to the built-in `oracle` defaults because the role name matches a packaged one.

### Remove roles you don't want

```json
{
  "schemaVersion": 4,
  "enabled": true,
  "roles": {
    "explorer": { "prompt": "default" },
    "fixer": { "prompt": "default" }
  }
}
```

The orchestrator only sees `explorer` and `fixer`. If it tries to delegate to `reviewer`, it gets an `Unknown team profile: reviewer. Configured profiles: explorer, fixer.` error and has to pick one of the two.

### Rename a role to fit your team's vocabulary

```json
"worker": {
  "whenToUse": "Use for bounded code changes. Implement a fix, add a test, edit one file.",
  "access": {
    "tools": ["read", "bash", "edit", "write"],
    "write": true
  },
  "prompt": "default"
}
```

Now the orchestrator delegates via `profileName: "worker"` instead of `"fixer"`. The prompt resolution falls back to the generic template because `worker` doesn't match any packaged prompt file. Write a custom `prompt` path or inline string if the generic template isn't specific enough.

### Add a repo-specific role with its own prompt file

```json
"migration-writer": {
  "whenToUse": "Use to draft a new DB migration. User must supply a description of the change; you produce a single SQL file under migrations/.",
  "thinkingLevel": "medium",
  "prompt": "prompts/migration-writer.md",
  "access": {
    "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
    "write": true,
    "pathScope": {
      "roots": ["migrations"],
      "allowReadOutsideRoots": true,
      "allowWrite": true
    }
  }
}
```

The path `prompts/migration-writer.md` is resolved relative to the config file's directory (`.pi/agent/`). Keep the file inside the project root or the loader will reject it with a path-escape error.

## Layering (global vs project)

Two optional files, in precedence order:

1. Project: `<cwd-or-ancestor>/.pi/agent/agents-team.json` (ancestor walk stops at `homedir()` so stale `/tmp` or shared-ancestor files don't silently bias)
2. Global: `~/.pi/agent/agents-team.json` (respects `PI_AGENT_TEAM_GLOBAL_CONFIG_PATH` env override — set to `""`/`"none"`/`"null"` to skip, or a path to redirect)
3. Built-in seven (when neither file is present).

**Project replaces global outright.** If both files exist, only the project file's roles are used. Nothing from global leaks through. This is deliberate. Role-level merging across layers is confusing and makes per-repo role sets hard to reason about.

**Precedence is by file presence, not validity.** If a project file exists — valid, schema-mismatched, or fatal-parse — project wins outright. A broken global config does NOT disable a valid project config (a typo in `~/.pi/agent/agents-team.json` used to break delegation machine-wide; the loader now only returns `status: "invalid"` when the WINNING layer's parse fails). A non-winning fatal parse becomes a diagnostic warning.

Two consequences worth knowing:

- If you want a globally-defined role in a specific repo, copy the block into the project file.
- If a project file exists but has an unsupported `schemaVersion`, the loader falls back to the built-in seven for that repo. It does **not** fall back to global, because doing so could quietly resurface write-capable global roles the project never sanctioned.

## Version bumps

Two counters, two purposes.

| Counter | Semantics | What happens on mismatch |
|---|---|---|
| `schemaVersion` | The shape contract. Bumped on breaking schema changes (renamed fields, re-layouts). | Hard warning toast on session start. Layer falls back to built-in roles. Run `/team-init <scope> --force` to regenerate. |
| `scaffoldVersion` | Freshness marker for scaffold content. Bumped when `/team-init` would write different defaults. | Soft warning toast suggesting re-init. File keeps loading as-is. |

Both constants live in `src/project-config/versions.ts`. Bump there, nothing else needs to change. See [CLAUDE.md](../CLAUDE.md) "Schema versioning" for the rules on which counter to move.

## Launch-time safety

The loader trusts whatever you put in the file. `launch-policy.ts` runs every time `delegate_task` fires and enforces invariants that can't be turned off:

1. **No recursive orchestrators.** `access.extensionMode: "inherit"` is rejected at load time. Launch-time overrides to `inherit` are also rejected.
2. **Writable roles need a `pathScope`.** Any role with `access.write: true` — or `access.tools` containing `edit` / `write` — must have a path scope at delegate time, either in `access.pathScope` or passed via `pathScopeRoots` on the `delegate_task` call. No "write anywhere" workers.
3. **Path scope roots may leave the project root by default.** Set `workerAccess.allowPathsOutsideProject: false` in the winning config to restrict delegated worker `pathScope` roots to `safety.projectRoot` (the project root when a project config exists, else the current cwd). Prompt paths always stay inside the project root/current cwd. When restriction is enabled, symlink escapes are checked with `realpathSync.native`, so the loader/launcher compare real locations, not just lexical paths.
4. **Prompt paths must stay inside the project root.** Same containment check as path scope roots. Pre-fix, the check was lexical only — a symlink under the project root pointing at `~/.ssh` would pass; the loader now calls `realpathSync.native` and rejects.

Launch-time overrides (tools, path scope, extension mode) may only narrow the role's declared rights. They cannot broaden them.

## Toggle commands

| Command | What it does |
|---|---|
| `/team-enable global\|local` | Sets `enabled: true` in the target file. Creates the file with just the flag if missing. |
| `/team-disable global\|local` | Sets `enabled: false` in the target file. |

Both commands are non-destructive:

- If the file is valid, `enabled` is patched in place. Your roles, prompts, models, and scopes stay untouched.
- If the file parses as JSON but drifts from the current schema (unknown fields, future fields, old-shape roles), the toggle preserves your raw object and only patches `enabled`. A warning surfaces that the file still needs a schema-level fix.
- If the file isn't parseable JSON at all, the toggle copies it to `YYYY-MM-DD-HHMMSS-agents-team.json` in the same directory (seconds included so same-minute reruns don't collide; exclusive-create so concurrent runs don't clobber each other's backups; original stays in place until the new write succeeds) before writing a minimal `{ schemaVersion, enabled }` replacement. All config writes are atomic via staged `<path>.tmp.<pid>.<ts>` → `renameSync`, so a ctrl-C mid-write leaves the original file intact.

Follow any toggle with `/reload` to apply the change in the current Pi session.

## Files that package this

- [`src/project-config/versions.ts`](../src/project-config/versions.ts): schema + scaffold version constants. Single place to bump.
- [`src/config.ts`](../src/config.ts): `DEFAULT_TEAM_CONFIG` including the seven built-in role specs.
- [`src/project-config/loader.ts`](../src/project-config/loader.ts): `loadActiveTeamConfig`, schema validation, role materialization, realpath containment, `resolveGlobalConfigPath` (honors `PI_AGENT_TEAM_GLOBAL_CONFIG_PATH`).
- [`src/safety/launch-policy.ts`](../src/safety/launch-policy.ts): platform invariants (recursion guard, write-scope enforcement, project-root containment).
- [`src/safety/path-scope.ts`](../src/safety/path-scope.ts): `realpath`-based path containment helpers.
- [`src/util/backup.ts`](../src/util/backup.ts): `atomicWriteFileSync` and exclusive-create backup (`copyFileSync` with `COPYFILE_EXCL`).
- [`prompts/agents/*.md`](../prompts/agents/): packaged worker prompts (including `_generic-worker.md`).

## Related docs

- [`operations.md`](operations.md): dashboard keys, steer/follow-up semantics, troubleshooting toggles and stale configs.
- [`prompting.md`](prompting.md): the `<final_answer>` contract every worker prompt must uphold.
- [`architecture.md`](architecture.md): runtime flow, state contract, animation layer.
