---
description: Fix an issue with Pi Agents Team
argument-hint: "[issue]"
---
Fix ${1:-the current issue} ${@:2} with Pi Agents Team.

Use Pi Agents Team for investigation and implementation when appropriate:
- If the fix is non-trivial, first map the fault with an `explorer` or `reviewer` worker.
- Use a `fixer` worker only with an explicit writable path scope.
- Verify with the narrowest relevant command first, then broader checks if risk warrants it.
- If team routing is off, work directly and note that no background workers were used.

Return:
- What changed and why.
- Files touched.
- Verification commands and results.
- Remaining risks or follow-up work.
