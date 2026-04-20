# Pi Agent Team

Pi Agent Team is a Pi package that turns the **main session** into an **orchestrator-led team session**.

The package is designed around one core promise:

- the visible Pi session stays the **single user-facing orchestrator**
- delegated specialists run as **separate Pi RPC workers**
- workers report back with **compact summaries, relay questions, and results**
- raw worker transcripts stay out of the main session unless an operator explicitly asks for them

This repository currently contains the **foundation scaffold** for that package: package metadata, orchestrator-mode session takeover wiring, and shared runtime/config contracts for profiles, workers, tasks, summaries, persistence, and UI state.

## Session contract

When the package is loaded, the active Pi session should behave like an orchestrator by default.

That means:

1. the main session owns all user dialogue
2. worker sessions are subordinate RPC peers, not separate user chats
3. delegation must stay explicit, bounded, and profile-driven
4. the orchestrator should preserve its own context by keeping worker output compact
5. workers must not recursively relaunch the full orchestrator runtime unless explicitly allowed in a future advanced mode

The current scaffold enforces that contract by:

- loading an orchestrator-mode system prompt addition on every turn
- exposing a starter `/team-status` command for diagnostics
- registering stable config/state contracts for later runtime, control-plane, comms, UI, and quality lanes
- publishing a Pi package manifest that points Pi at the extension entrypoint

## Current package layout

```text
package.json
README.md
extensions/
  pi-agent-team/
    index.ts
src/
  config.ts
  types.ts
docs/
  architecture.md
```

Additional directories from the architecture plan will land in later tasks:

- `src/runtime/`
- `src/control-plane/`
- `src/comms/`
- `src/profiles/`
- `src/safety/`
- `src/ui/`
- `prompts/`
- `tests/`
- `scripts/smoke/`

## Install and load

Install the package from a local path:

```bash
pi install /absolute/path/to/pi-agent-team
```

Or test the extension entry directly during development:

```bash
pi -e ./extensions/pi-agent-team/index.ts -p "/team-status"
```

## Development

Install development dependencies and run typecheck:

```bash
npm install
npm run typecheck
```

## Architecture reference

The source-of-truth runtime design lives in [docs/architecture.md](docs/architecture.md).

Highlights:

- one visible orchestrator session
- many subordinate RPC worker sessions
- compact result and relay contracts
- explicit launch safety and path scoping
- Pi-native extension, package, RPC, and TUI integration

## Planned specialist profiles

The initial profile contract includes:

- `explorer`
- `librarian`
- `oracle`
- `designer`
- `fixer`
- `reviewer`
- `observer`

The foundation scaffold defines their config shape and starter defaults. Later tasks will add prompt files, launch policy, and actual worker execution logic.
