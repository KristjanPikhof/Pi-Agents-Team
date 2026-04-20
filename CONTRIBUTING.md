# Contributing

Thanks for helping out. This guide covers local setup, the test discipline, and what to check before opening a PR. Read [`CLAUDE.md`](CLAUDE.md) first for the load-bearing invariants; most bugs in this repo have historically been race conditions on worker status transitions, and the invariants section names them explicitly.

## Local setup

```bash
git clone git@github.com:KristjanPikhof/pi-agents-team.git
cd pi-agents-team
npm install
npm run check            # typecheck + all tests, must be green before you push
```

Run the extension against your working copy without going through `pi install`:

```bash
pi -e ./extensions/pi-agent-team/index.ts
pi -e ./extensions/pi-agent-team/index.ts -p "/team"   # open straight into the dashboard
```

If you want to install the local checkout as a real Pi package instead:

```bash
pi install /absolute/path/to/pi-agents-team
```

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test tests/**/*.test.ts (node:test runner, node:assert/strict)
npm run check            # typecheck + test, one shot
npm run smoke:runtime    # spawns a real pi RPC worker
npm run smoke:team       # exercises TeamManager end-to-end
```

Run a single test file with `tsx --test tests/runtime/worker-manager.test.ts`.

## Test discipline

The current test count is **53**. If your change reduces that without a corresponding deletion, something regressed.

Unit tests lean on `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` instead of spawning real `pi` processes. Use `setState(patch)` to drive `isStreaming` from outside; `autoCompletePrompt: false` lets tests emit the exit event manually via `completePrompt()`. When you change the transport shape, check which tests rely on `autoCompletePrompt`, `promptText`, and `setState`. Those are the only seams for testing runtime behavior without a real Pi process.

## Before opening a PR

1. `npm run check` is green.
2. If you changed operator-facing behavior (commands, dashboard keys, glyphs, tool parameters, delivery semantics), update [`README.md`](README.md) and [`docs/operations.md`](docs/operations.md) in the same commit.
3. If you changed contract-level behavior (final_answer shape, worker responsibilities, wait semantics), update [`prompts/orchestrator.md`](prompts/orchestrator.md) or the relevant [`prompts/agents/*.md`](prompts/agents/). The LLM reads those directly.
4. If you added or dropped a slash command, update the sorted list assertion in `tests/extension-wiring.test.ts`.
5. If you added or renamed a profile, update both `profiles/*.md` and `src/profiles/default-profiles.ts` (the loader test enforces parity).

## Package layout

```text
extensions/pi-agent-team/index.ts    # extension entrypoint, tool + command registration, UI wiring
src/runtime/                         # worker process, RPC client, event normalizer, worker manager
src/control-plane/                   # team manager, task registry, persistence snapshots
src/comms/                           # steer/follow-up routing, passive ping, summary parser, relay extractor
src/profiles/                        # packaged profile specs + loader
src/safety/                          # launch policy and path-scope validation
src/ui/                              # status widget, dashboard text, interactive overlay
src/commands/                        # operator slash commands
src/util/                            # clipboard, Levenshtein, shared helpers
prompts/                             # orchestrator and per-role worker contracts
profiles/                            # markdown profile definitions
tests/                               # unit + integration coverage (node:test)
scripts/smoke/                       # runtime-worker and team-flow smokes
```

## Conventions

- Strict TypeScript, ESM (`"type": "module"`).
- Tests use `node:test` and `node:assert/strict`, not jest/vitest/bun.
- TypeBox (`@sinclair/typebox`) defines tool parameter schemas. Keep schemas and the params shape passed to `TeamManager` in sync.
- Don't add emojis to files unless asked. The widget uses braille spinner and ASCII glyphs on purpose.
- Don't leave backward-compat shims when you remove something. Git history is the record.

## Anti-patterns

[`CLAUDE.md`](CLAUDE.md) has the full list. A few worth repeating here:

- Don't persist transcripts or raw events. `WorkerManager` buffers them in memory on purpose.
- Don't bypass `TeamManager` from commands. Commands are thin wrappers; the control plane is the only place that touches the registry and the runtime.
- Don't emit toasts as if they were conversation. Terminal-status toasts and relay-question toasts are UI-only.
- Don't auto-prune terminal workers. Pruning is operator-initiated (`/team-prune`).
- Don't add orchestrator token usage to the widget's `Σ` row. Pi's footer already shows it.

## Reporting issues

File bugs and feature requests at [github.com/KristjanPikhof/pi-agents-team/issues](https://github.com/KristjanPikhof/pi-agents-team/issues). A good report includes the session reason (`startup` / `reload` / `resume` / `fork` / `new`), the worker profile, and the last line of the relevant toast or widget text.
