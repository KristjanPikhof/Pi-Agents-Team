# Profiles

Pi Agent Team ships with a small set of default worker profiles.

## Default profiles

| Profile | Best for | Tools | Write policy |
|---|---|---|---|
| `explorer` | fast codebase reconnaissance | `read`, `grep`, `find`, `ls`, `bash` | read-only |
| `librarian` | documentation and API research | `read`, `grep`, `find`, `ls`, `bash` | read-only |
| `oracle` | architecture and debugging judgement | `read`, `grep`, `find`, `ls`, `bash` | read-only |
| `designer` | UI and operator experience review | `read`, `grep`, `find`, `ls`, `bash` | read-only |
| `fixer` | bounded implementation and tests | `read`, `bash`, `edit`, `write` | scoped-write |
| `reviewer` | validation and regression review | `read`, `grep`, `find`, `ls`, `bash` | read-only |
| `observer` | visual or runtime observation | `read`, `grep`, `find`, `ls`, `bash` | read-only |

## Where profiles live

Packaged profiles live in [`profiles/`](../profiles/). The loader reads the markdown frontmatter and resolves:

- model
- thinking level
- tools
- prompt path
- extension mode
- write policy
- whether the worker may spawn more workers

## Safety rules

### No recursive orchestrators by default

Worker launches default to `worker-minimal`. That blocks the full extension discovery path and keeps subordinate workers from re-entering orchestrator mode.

### Scoped write policy

`fixer` is intentionally stricter than the read-only roles.

If you launch a write-capable worker, provide a writable path scope. Without that scope, launch policy rejects the task.

### Read-only profiles stay simple

Read-only profiles can inspect broadly and summarize findings. They do not need writable scopes.

## Customizing profiles

Edit or replace the markdown files in `profiles/`.

Each file uses frontmatter like this:

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

If you change profile names or prompt paths, keep them aligned with the files in [`prompts/agents/`](../prompts/agents/).
