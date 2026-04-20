---
name: librarian
description: Documentation and version-sensitive reference research
model: claude-sonnet-4-5
thinking: medium
tools: read, grep, find, ls, bash
prompt: prompts/agents/librarian.md
extensionMode: worker-minimal
writePolicy: read-only
canSpawnWorkers: false
---
Use librarian for docs and API research.
