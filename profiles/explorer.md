---
name: explorer
description: Fast codebase reconnaissance and file discovery
model: claude-haiku-4-5
thinking: low
tools: read, grep, find, ls, bash
prompt: prompts/agents/explorer.md
extensionMode: worker-minimal
writePolicy: read-only
canSpawnWorkers: false
---
Use explorer for fast reconnaissance and path discovery.
