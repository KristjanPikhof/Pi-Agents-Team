# Roles (agents-team.json)

**TL;DR.** Pi Agents Team ships with seven default worker roles. Drop a file at `.pi/agent/agents-team.json` to customize them, add new ones, or cut the list down. The orchestrator only delegates to roles that exist in the loaded config, so the file is a direct knob on what your team of workers can do.

The fastest path: run `/team-init` in a repo, edit the resulting file, run `/reload`. Done.

## When to reach for this

| Goal | What to do |
|---|---|
| Use the extension as-is with sensible defaults | Nothing. No config file needed. |
| Tune one role (e.g. pin a model for `oracle`) | `/team-init`, edit that one role block, `/reload`. |
| Swap the default names for your own vocabulary | Edit the `roles` keys after `/team-init`. |
| Build a repo-specific team from scratch | `/team-init`, delete every role you don't want, add the ones you do. |
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
| `reviewer` | Validate a change, hunt regressions, confirm tests cover what they claim. | `read`, `grep`, `find`, `ls`, `bash` | high | no |
| `observer` | Screenshots, images, non-code artifacts. | `read`, `grep`, `find`, `ls`, `bash` | low | no |
| `fixer` | Bounded code changes. Implement a fix, add a test, edit one file. | `read`, `bash`, `edit`, `write` | medium | yes |

Only `fixer` can write by default. Every write-capable role (that is, `access.write: true` OR `access.tools` containing `edit`/`write`) needs an explicit `pathScope` at delegate time. That's enforced by launch-policy, not by role config, so you can't accidentally un-safe it.

> **Path scope honesty.** `pathScope` is a prompt convention + delegate-time check, not an OS sandbox. Pi does not jail worker processes at the kernel level; `bash` in particular can execute arbitrary shell commands in the worker's cwd. Every built-in read-only role ships with `bash` because git/ls/grep workflows need it. If you include `bash` in a profile, you are trusting the orchestrator LLM + the role prompt to honor the scope. For stricter containment (untrusted configs, unfamiliar repos), stop delegating to write-capable profiles or drop `bash` from the role's tools. See [CLAUDE.md](../CLAUDE.md) "Path scope is a prompt convention" for the full rationale.

## Creating or editing roles

### Scaffold a starter file

```
/team-init           → writes ./.pi/agent/agents-team.json (local default)
/team-init local     → writes ./.pi/agent/agents-team.json
/team-init global    → writes ~/.pi/agent/agents-team.json
/team-init --force   → replace existing file (backs up the previous one first)
```

The scaffold contains all seven built-in roles in the current shape. `/team-init local` writes the local file and stamps each role's packaged `thinkingLevel` default into JSON; it does not copy the orchestrator's current live Pi thinking level. Edit whatever you want.

| Role | Scaffolded `thinkingLevel` |
|---|---|
| `explorer` | `low` |
| `librarian` | `medium` |
| `oracle` | `high` |
| `designer` | `medium` |
| `fixer` | `medium` |
| `reviewer` | `high` |
| `observer` | `low` |

### The shape, field by field

```json
{
  "schemaVersion": 4,
  "scaffoldVersion": 3,
  "enabled": true,
  "workerAccess": {
    "allowPathsOutsideProject": true
  },
  "display": {
    "cost": true
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
| `scaffoldVersion` | no | Freshness marker. Currently `3`. Mismatched or missing values on the active config layer just nudge you to re-run `/team-init <scope> --force` to pick up newer defaults. |
| `enabled` | no | `false` puts the extension in dormant mode (tools refuse, UI clears). Default `true`. |
| `routingMode` | no | `"team"` or `"solo"`. Sticky default for orchestrator routing. `/team-init` seeds it as `"team"`; `/team-enable on\|off --local` or `--global` rewrites it explicitly, and you can hand-edit it. No-flag `/team-enable on\|off` is session-only. Default `"team"` when `enabled: true` and the field is missing. See [`operations.md`](operations.md#toggle-routing-without-reload). |
| `workerAccess` | no | Global access policy for delegated workers. Omit to keep the defaults. |
| `display` | no | UI display options. Omit to keep the defaults. See "Display options" below. |
| `roles.<name>` | no | Free-form map. Name whatever you want. If `roles` is missing or empty, all built-in roles load. If `roles` contains entries, only those declared roles load. |

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

### Display options

| Field | Type | Default | Notes |
|---|---|---|---|
| `display.cost` | boolean | `true` | Show the `Σ` aggregate row in the footer widget and the **Cost** tab in the `/team` overlay. Set to `false` to hide both. |

Example — hide cost UI:

```json
{
  "schemaVersion": 4,
  "display": {
    "cost": false
  }
}
```

### Per-role fields

All optional. Omit to get the default.

| Field | Type | Default | Notes |
|---|---|---|---|
| `whenToUse` | string | `""` | The trigger sentence shown to the orchestrator LLM. Write it as `"Use for / when / to ..."` so the model can match it against user requests. |
| `model` | string | `"default"` | `"default"` inherits the orchestrator's current model. Otherwise a canonical Pi model ID in `<provider>/<model-id>` form (check `pi --help` or your Pi install's model list for exact names — available models are install-specific). |
| `thinkingLevel` | string | cascade | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `max` is opt-in and model/provider-dependent. See "Thinking level cascade" below. |
| `access` | object | default read tools | Worker capabilities for this role. See "Per-role access fields" below. |
| `prompt` | string | `"default"` | See "Prompt resolution" below. |

### Thinking level cascade

`thinkingLevel` is optional. The `/team-init` scaffold includes explicit role defaults so the generated file is immediately stable and editable. If you delete a role's `thinkingLevel`, then at launch time `src/safety/launch-policy.ts` resolves the worker's requested level in this order:

| Tier | Source |
|---|---|
| 1 | Explicit role `thinkingLevel` in `agents-team.json`. |
| 2 | Built-in role default when the role falls back to a packaged profile. |
| 3 | The orchestrator's live Pi thinking level from `pi.getThinkingLevel()`. |
| 4 | `medium`, used only when none of the above exists. |

Invalid role values are handled per field. The loader drops only that role's bad `thinkingLevel`, keeps the rest of the config, and emits a warning toast on session start. Fix the typo and reload. Adding `max` support does not change the packaged role defaults, schema/scaffold versions, or existing config files, and it does not trigger config regeneration.

Use omission for inheritance:

| JSON | Result |
|---|---|
| `"thinkingLevel": "high"` | Requests `high` for that role. |
| `"thinkingLevel": "max"` | Explicitly opts into `max`; Pi may clamp it for the selected model/provider. |
| No `thinkingLevel` field | Inherits from the cascade above. |
| `"thinkingLevel": "default"` | Invalid. The field is dropped and a warning toast is shown. |
| `"thinkingLevel": ""` | Invalid. The field is dropped and a warning toast is shown. |

Pi owns the actual model support matrix. In the installed Pi documentation, see the model registry's thinking-level mapping in `docs/models.md`, the `get_state` response and Thinking Level commands in `docs/rpc.md`, and the thinking-level setting in `docs/settings.md`. `xhigh` and `max` are model/provider-dependent, and Pi may clamp unsupported levels to the closest supported effective level.

### Per-role access fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `access.tools` | string[] | `["read", "grep", "find", "ls", "bash"]` | Tool set the worker can use. You declare it. No ceiling. |
| `access.write` | boolean | `false` | `true` allows `edit`/`write`. Requires a `pathScope` at delegate time (platform-level safety). |
| `access.pathScope` | object | omitted | Default path scope for this role. The orchestrator can also pass `pathScopeRoots` at delegate time. |
| `access.extensionMode` | string | `"worker-minimal"` | `"worker-minimal"` or `"disable"`. `"inherit"` is rejected to prevent recursive orchestrators. |
| `access.extensions` | string[] | omitted | Explicit Pi extension sources for this role's workers. Use this for provider/model extensions that must be loaded before the worker model is selected. |
| `access.canSpawnWorkers` | boolean | `false` | Reserved for role metadata. Workers still run as background RPC peers, not nested user-facing agents. |

Project Trust is not a role field. Worker launches inside the active project root get `--approve` or `--no-approve` from the orchestrator's current session trust. Launches outside that root, or host contexts that unexpectedly provide no trust decision, get no trust override.

`access.extensions` accepts the same source strings Pi accepts for `--extension`/`-e`: local paths, npm specs, and git/http sources. Local relative paths resolve from the `agents-team.json` layer root. In `worker-minimal` mode the worker still starts with `--no-extensions`; the runtime then passes each listed source with `--extension`, so ambient discovery stays disabled while explicitly listed provider extensions can run. `access.extensionMode: "disable"` cannot be combined with `access.extensions`.

Use `access.extensions` for extensions that call `pi.registerProvider()` and make custom model IDs available during worker startup. Do not put the team extension itself there: `pi-agents-team`, `npm:pi-agents-team`, and this package's own extension entrypoints are rejected to prevent recursive orchestrators.

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
| Any string that does not resolve to a file, path-shaped (`./`, `~/`, `http(s)://`, ends in `.md`, contains `/` without whitespace) | any | Hard error (`project_prompt_missing`). The layer is invalid and delegation stays disabled until the file path is fixed. |
| Any string that does not resolve to a file, prose-shaped | any | Treated as inline prompt text, no warning. This is the explicit escape hatch for "I want to write the prompt inline." |
| Empty / whitespace-only string | any | Warning (`project_prompt_empty`), falls back to the generic worker template. |
| Path that escapes the project root (including symlinks whose realpath is outside the real project root) | any | Hard error (`project_path_escape`). Layer is marked invalid, delegation disabled until fixed. |

Prompt files resolve against the config layer root when the session loads and remain absolute at launch. A worker can therefore use a sibling worktree as its `cwd` without needing another copy of the config or prompt file.

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

### Pin a custom provider model for one role

```json
"oracle": {
  "model": "myAnthropic/claude-opus-4-7",
  "thinkingLevel": "xhigh",
  "access": {
    "extensionMode": "worker-minimal",
    "extensions": ["./extensions/myAnthropic-provider.ts"]
  }
}
```

Replace the extension source with the path, npm spec, or git/http source that registers your provider with `pi.registerProvider`. At launch, the worker receives `--no-extensions --extension ./extensions/myAnthropic-provider.ts`; Pi can then resolve `myAnthropic/claude-opus-4-7` before the RPC worker starts.

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

The project-local file is only considered after the Pi session reports the project as trusted. Until then, the loader skips `.pi/agent/agents-team.json` and uses the global file or built-ins.

**Project replaces global outright once it is trusted and present.** If both files exist, only the project file's roles are used. Nothing from global leaks through. This is deliberate. Role-level merging across layers is confusing and makes per-repo role sets hard to reason about.

**Precedence is by file presence, not validity.** If a project file exists — valid, schema-mismatched, or fatal-parse — project wins outright. A broken global config does NOT disable a valid project config (a typo in `~/.pi/agent/agents-team.json` used to break delegation machine-wide; the loader now only returns `status: "invalid"` when the WINNING layer's parse fails). A non-winning fatal parse becomes a diagnostic warning.

Two consequences worth knowing:

- If you want a globally-defined role in a specific repo, copy the block into the project file.
- If a project file exists but has an unsupported `schemaVersion`, the loader falls back to the built-in seven for that repo. It does **not** fall back to global, because doing so could quietly resurface write-capable global roles the project never sanctioned.

## Version bumps

Two counters, two purposes.

| Counter | Semantics | What happens on mismatch |
|---|---|---|
| `schemaVersion` | The shape contract. Bumped on breaking schema changes (renamed fields, re-layouts). | Hard warning toast on session start. The active layer falls back to built-in roles. Run `/team-init <scope> --force` to regenerate. |
| `scaffoldVersion` | Freshness marker for scaffold content. Bumped when `/team-init` would write different defaults. | Soft warning toast suggesting re-init. The active file keeps loading as-is. |

Freshness is checked for the **active config layer only**. Active means project-local if a project file exists, otherwise global if a global file exists, otherwise no config. Non-winning layers can still produce parse diagnostics, but stale or missing `scaffoldVersion` in a non-winning layer does not toast by default.

| Config state at boot | Active layer | Freshness behavior |
|---|---|---|
| Project file exists and has current `scaffoldVersion` | Project/local | No freshness toast. |
| Project file exists and has stale `scaffoldVersion` | Project/local | Soft stale-scaffold toast for the project scope; config still loads. |
| Project file exists, uses the current schema, and omits `scaffoldVersion` | Project/local | Soft unknown-freshness toast for the project scope; config still loads. |
| Project file exists with schema mismatch or fatal parse | Project/local | Schema/parse warning path applies separately; project still wins by presence and does not fall back to global. |
| No project file; global file has stale or missing `scaffoldVersion` | Global | Soft stale or unknown-freshness toast for the global scope; config still loads when otherwise valid. |
| No project or global file | None | No freshness toast; built-in roles are used. |
| Both project and global files exist; only global is stale | Project/local | No default stale toast for global because it is not the active layer. |

Freshness warnings are de-duped per process by active scope plus the active file's `scaffoldVersion` value, or `unknown` when the field is missing. Reloading in the same process should not spam repeated toasts for the same active freshness state.

Refresh explicitly with `/team-init <local|global> --force`. The command backs up the previous file first, writes the current `schemaVersion` and `scaffoldVersion`, and stamps the current packaged defaults.

Both constants live in `src/project-config/versions.ts` (currently `schemaVersion=4`, `scaffoldVersion=3`). Bump there, nothing else needs to change. See [CLAUDE.md](../CLAUDE.md) "Schema versioning" for the rules on which counter to move.

## Launch-time safety

The loader trusts whatever you put in the file. `launch-policy.ts` runs every time `delegate_task` fires and enforces invariants that can't be turned off:

1. **No recursive orchestrators.** `access.extensionMode: "inherit"` is rejected at load time. Launch-time overrides to `inherit` are also rejected. `access.extensions` sources that would load `pi-agents-team` itself are rejected for the same reason.
2. **Writable roles need a `pathScope`.** Any role with `access.write: true` — or `access.tools` containing `edit` / `write` — must have a path scope at delegate time, either in `access.pathScope` or passed via `pathScopeRoots` on the `delegate_task` call. No "write anywhere" workers.
3. **Path scope roots may leave the project root by default.** Set `workerAccess.allowPathsOutsideProject: false` in the winning config to restrict delegated worker `pathScope` roots to `safety.projectRoot` (the project root when a project config exists, else the current cwd). Prompt paths always stay inside the project root/current cwd. When restriction is enabled, symlink escapes are checked with `realpathSync.native`, so the loader/launcher compare real locations, not just lexical paths.
4. **Prompt paths must stay inside the project root.** Same containment check as path scope roots. Pre-fix, the check was lexical only — a symlink under the project root pointing at `~/.ssh` would pass; the loader now calls `realpathSync.native` and rejects.

Launch-time overrides (tools, path scope, extension mode) may only narrow the role's declared rights. They cannot broaden them.

## Routing commands

| Command | What it does |
|---|---|
| `/team-enable on [--local\|--global]` | Flip routing to `team` for the live session. With no flag, the change resets on `/reload` or restart. Pass `--local` or `--global` to persist `routingMode: "team"` to that scope. Errors when `enabled: false`. |
| `/team-enable off [--local\|--global]` | Flip routing to `solo` for the live session. With no flag, the change resets on `/reload` or restart. Pass `--local` or `--global` to persist `routingMode: "solo"`; live workers stay reachable and only `delegate_task` is gated off. |

Both forms are non-destructive:

- If the file is valid, `routingMode` is patched in place. Your roles, prompts, models, scopes, and `enabled` flag stay untouched.
- If the file parses as JSON but drifts from the current schema, the command preserves your raw object and only patches `routingMode`. A warning surfaces that the file still needs a schema-level fix.
- If the file isn't parseable JSON at all, the command errors out without touching the in-memory toggle.

All config writes are atomic via staged `<path>.tmp.<pid>.<ts>` → `renameSync`, so a ctrl-C mid-write leaves the original file intact. Legacy `--persist local|global` is still accepted as a deprecated alias for compatibility; prefer `--local` / `--global`. Writing `--global` while a project-local config exists emits a warning because that local file shadows the global routing mode in the current project.

To toggle the `enabled` flag itself, edit `agents-team.json` by hand and follow with `/reload`. The `enabled` flag controls whether delegation is active at all; `/team-enable on|off` controls only the routing mode within an already-enabled setup.

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
