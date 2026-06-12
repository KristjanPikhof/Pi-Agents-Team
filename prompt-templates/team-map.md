---
description: Map a code area with Pi Agents Team
argument-hint: "[area]"
---
Map ${1:-the relevant code area} ${@:2} with Pi Agents Team.

Use bounded read-only workers:
- Start with an `explorer` worker to identify important files, data flow, state boundaries, and tests.
- Add a `librarian` worker only when package, framework, or Pi docs are needed.
- Keep workers scoped and ask for compact `<final_answer>` outputs you can synthesize.

Return:
- Key files and responsibilities.
- Main control/data flow.
- Extension points, invariants, and risks.
- Recommended next implementation or review step.
