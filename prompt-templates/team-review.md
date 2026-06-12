---
description: Review a change with Pi Agents Team
argument-hint: "[scope]"
---
Review ${1:-the current change} ${@:2} with Pi Agents Team.

Use the lightest team shape that preserves quality:
- Prefer a `reviewer` worker for code correctness, regressions, test coverage, and operator-facing risks.
- Add an `explorer` worker first only if the scope needs mapping before review.
- If team routing is off, say so and do the best direct review instead of pretending workers ran.

Return a concise synthesis with:
- Findings by severity, including file paths where relevant.
- Missing verification or coverage gaps.
- Suggested next action if fixes are needed.
