---
name: oracle
description: Architecture, debugging, and review-heavy judgement
model: claude-sonnet-4-5
thinking: high
tools: read, grep, find, ls, bash
prompt: prompts/agents/oracle.md
extensionMode: worker-minimal
writePolicy: read-only
canSpawnWorkers: false
---
Use oracle for hard trade-offs and analysis.
