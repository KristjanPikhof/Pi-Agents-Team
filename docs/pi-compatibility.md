# Pi compatibility review

Extension release: `2026.10.8`. Previous Pi baseline: `0.85.1`. Development SDKs and minimum supported host/worker: `1.1.0`. Node remains `>=22.19.0`.

The review covers all 13 published releases after 0.85.1 through 1.1.0, including 0.86.x and 0.87.x, which were absent from the supplied changelog excerpt. Sources: Pi's [release history](https://github.com/earendil-works/pi/releases), [1.1.0 changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md), and the installed 1.1.0 SDK declarations and RPC/CLI implementation.

## Changes applied

| Pi change | Extension response |
|---|---|
| 1.1.0 adds `agent_settled.aborted` | Cancellation wins over successful assistant output. A run cancelled before its first response becomes `aborted`, wakes waits, and cannot be reused. Duplicate and late settlement guards remain. |
| 1.1.0 adds tool `durationMs` | Keep the recorded duration in memory-only Activity. Console uses it instead of event arrival time; copies include milliseconds. Missing durations retain the display fallback. |
| 0.99.0 adds RPC input dispositions | A fresh prompt returning `handled` fails with a diagnostic instead of waiting forever for a run that never started. Handled input during a running task keeps the existing settlement guard. |
| 1.0.4 preserves MCP tools with `--tools` | Exclude `mcp__*` when the worker selects no server tool names, and exclude each unlisted MCP resource tool. Explicitly selected server/resource tools remain available. Empty lists still use `--no-tools`. |
| 1.0.4 adds patterns; 1.1.0 adds CLI `+name`/`-name` selectors | Worker role and override lists require exact names. Reject selectors and embedded separators so they cannot expand a declared tool set or bypass the edit/write scope check. |
| SDK and shared TypeBox versions changed | Pin the three Pi development packages to 1.1.0 and TypeBox to Pi's 1.3.27. Keep host-provided modules in peer dependencies and raise the runtime minimum to 1.1.0. |

## Existing behavior checked

| Pi changes | Decision |
|---|---|
| 0.86.0 changes provider transcript context and JSON-compatible tool values; 0.87.0 adds context edits and actionable boundaries | Compile against the new types. The extension does not implement provider streams, rewrite agent history, exhaustively switch on session entries, or use the removed `shouldStopAfterTurn` API. Keep completion at notification-only `agent_settled`. |
| 0.86.0 fixes RPC steer/follow-up input hooks; 0.87.0 defers runs requested by settled handlers | Keep the existing RPC delivery and settlement guards. Do not treat `agent_end` or non-streaming `get_state` as completion. |
| 0.99.0 adds MCP/codemode/tool exposure and changes `--no-extensions` | Keep worker launches minimal. Roles can explicitly load `builtin:mcp`, `builtin:codemode`, or `builtin:llama.cpp` through `access.extensions`. Do not enable them in every worker. |
| 0.99.0 introduces the system theme; 1.0.0 defaults to fullscreen; 1.1.0 adds renderer `outputPad` | Keep Pi theme callbacks, terminal-width helpers, and the custom `/team` overlay. The extension has no custom tool-result renderer that needs `outputPad`. |
| 0.99.0 through 1.1.0 fix nested-tool, fast-mode, cache, and prompt-tier costs | Continue using Pi-reported session cost unchanged, including fractional values. Totals remain workers-only and retain pruned usage once. Do not add a local price table. |
| New chat models and thinking mappings | Use Pi's current model catalog and existing thinking-level cascade/clamp notification. Keep role defaults. Image and classifier catalogs are separate from worker chat models. |
| Provider retries, compaction, MCP shutdown, and OAuth fixes | Use Pi's fixes through the upgraded worker runtime. Existing diagnostics remain observational until settlement. |
| 1.1.0 adds OSC 7501 program status | Let Pi report the visible session's status. Worker RPC state remains the authority for the team dashboard; do not add terminal escape parsing. |

## Operator migration

Upgrade both the host and any custom `rpc.command` to Pi `>=1.1.0`, then restart Pi. The extension still permits newer worker versions and warns once per session when host and worker versions differ.

Rename Azure provider references from `azure-openai-responses` to `azure` in Pi auth, models, settings, and role model IDs. Replace worker tool patterns or additive selectors with exact names. Explicitly load required Pi built-ins in `access.extensions`; MCP tools also need exact names in `access.tools`.

Team state, project schema, scaffold versions, and built-in role defaults stay unchanged because this release does not change their formats. See [operations](operations.md), [role configuration](profiles.md), and [runtime architecture](architecture.md) for the current behavior and validation commands.
