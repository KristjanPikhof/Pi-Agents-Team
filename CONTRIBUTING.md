# Contributing

Thanks for helping out. This guide covers local setup, the test discipline, and what to check before opening a PR. Read [`CLAUDE.md`](CLAUDE.md) first for the load-bearing invariants; most bugs in this repo have historically been race conditions on worker status transitions, and the invariants section names them explicitly.

## Local setup

Use Node `>=22.19.0`. Development validation uses exactly Pi `0.83.0`. The supported host and worker minimum remains Pi `0.80.6`. npm and `package-lock.json` are the only supported dependency and lock workflow; do not add or regenerate a Bun lock.

```bash
git clone git@github.com:KristjanPikhof/pi-agents-team.git
cd pi-agents-team
npm install
npm run check            # typecheck + all tests, must be green before you push
```

Run the source shim against your working copy without going through `pi install`:

```bash
pi -e ./extensions/index.ts
```

This checks the local-development path. Pi loads `extensions/index.ts` through `jiti`; it does not check the compiled or published package entrypoint. To exercise the TUI overlay, start Pi interactively and enter `/team`. Do not use `-p "/team"` as an overlay check: `-p` submits a prompt and does not exercise interactive overlay input or rendering.

Validate the compiled and published paths separately:

```bash
npm run build
pi -e ./dist/extensions/index.js
npx tsx --test tests/package-manifest.test.ts tests/package-publish.test.ts
```

Installed consumers use the compiled npm package. The focused package tests check the `dist/` manifest contract, pack the package, install it offline, and import it from a clean consumer. Direct Git package installs are not supported because `dist/` is ignored and Pi's Git install flow does not build it.

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test root and nested tests (node:test runner, node:assert/strict)
npm run check            # typecheck + test, one shot
npm run build            # compile the publishable package into dist/
npm run build:publish    # same publish build, used by prepack
npm run smoke:runtime    # spawns a real pi RPC worker
npm run smoke:team       # exercises TeamManager end-to-end
```

Run a single test file with `tsx --test tests/runtime/worker-manager.test.ts`.

Run dependency changes with npm and commit the resulting `package-lock.json`. Do not use Bun or another package manager to resolve this repository.

Both build commands run `scripts/build-publish.mjs`. The script clears `dist/`, compiles source files to native ESM JavaScript plus `.d.ts` declarations, and copies `prompts/` and `profiles/` into the output. `npm pack` and `npm publish` run `prepack`, which calls `npm run build:publish`; publishing also runs `prepublishOnly` (`npm run check`). Keep `dist/` ignored because it is generated for packaging, not maintained as source.

## Test discipline

Unit tests lean on `MockWorkerTransport` / `MockWorkerHandle` in `tests/runtime/test-helpers.ts` instead of spawning real `pi` processes. Use `setState(patch)` to drive `isStreaming` from outside; `autoCompletePrompt: false` lets tests emit the exit event manually via `completePrompt()`. When you change the transport shape, check which tests rely on `autoCompletePrompt`, `promptText`, and `setState`. Those are the only seams for testing runtime behavior without a real Pi process.

## Before opening a PR

1. `npm run check` is green.
2. If you changed operator-facing behavior (commands, dashboard keys, glyphs, tool parameters, delivery semantics), update [`README.md`](README.md) and [`docs/operations.md`](docs/operations.md) in the same commit.
2.5. If you changed project role config discovery, rights ceilings, prompt lookup, or invalid-config behavior, update [`docs/profiles.md`](docs/profiles.md) and any affected tests under `tests/project-config/`, `tests/control-plane/`, or `tests/prompts/` in the same commit.
3. If you changed contract-level behavior (final_answer shape, worker responsibilities, wait semantics), update [`prompts/orchestrator.md`](prompts/orchestrator.md) or the relevant [`prompts/agents/*.md`](prompts/agents/). The LLM reads those directly.
4. If you added or dropped a slash command, update the sorted list assertion in `tests/extension-wiring.test.ts`.
5. If you added or renamed a profile, update both `profiles/*.md` and `src/profiles/default-profiles.ts` (the loader test enforces parity).

## Package layout

```text
extensions/index.ts                 # local-development shim and source package entrypoint
extensions/pi-agent-team/index.ts   # source implementation entrypoint, registration, and UI wiring
dist/extensions/index.js            # generated npm/Pi entrypoint (native ESM)
dist/**/*.d.ts                      # generated TypeScript declarations
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
- Don't auto-prune terminal workers. Pruning is operator-initiated from the `/team` overlay with `p`.
- Don't add orchestrator token usage to the widget's `Σ` row. Pi's footer already shows it.

## Reporting issues

File bugs and feature requests at [github.com/KristjanPikhof/pi-agents-team/issues](https://github.com/KristjanPikhof/pi-agents-team/issues). A good report includes the session reason (`startup` / `reload` / `resume` / `fork` / `new`), the worker profile, and the last line of the relevant toast or widget text.
