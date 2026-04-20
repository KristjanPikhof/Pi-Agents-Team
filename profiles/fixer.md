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
Use fixer for scoped implementation work with explicit path ownership.
