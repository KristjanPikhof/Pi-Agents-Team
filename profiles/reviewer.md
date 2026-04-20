---
name: reviewer
description: Validation, critique, and regression review
model: claude-sonnet-4-5
thinking: medium
tools: read, grep, find, ls, bash
prompt: prompts/agents/reviewer.md
extensionMode: worker-minimal
writePolicy: read-only
canSpawnWorkers: false
---
Use reviewer for validation and regression checks.
