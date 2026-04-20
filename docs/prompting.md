# Prompt Contracts

Pi Agent Team uses **Pi-native prompt contracts** for the orchestrator and worker roles.

## Design principle

These prompts reuse delegation ideas such as role separation, compact reporting, escalation, and bounded specialist work. They do **not** copy prompt text, branding, or persona flavor from other systems.

The package goal is simple:

- one visible orchestrator session
- many subordinate RPC workers
- compact worker outputs
- explicit supervision through steer, follow-up, ping, and relay behavior

## Orchestrator contract

The orchestrator prompt owns:

- user dialogue
- delegation decisions
- worker selection
- compact result integration
- relay-question resolution
- supervision of running and idle workers

The orchestrator must never present delegated workers as separate user-facing agents.

## Worker contracts

Each worker prompt assumes:

- it is subordinate to the orchestrator
- it should not speak to the user directly
- it should keep output compact and structured
- it should raise relay questions with an assumption instead of blocking forever

## Result conventions

Worker prompts intentionally use short, machine-friendly result sections such as:

- goal
- findings or changed_files
- risks
- next_recommendation
- relay_question plus assumption

The exact field names vary by role, but the compact reporting principle stays the same.

## Current worker set

- explorer
- librarian
- oracle
- designer
- fixer
- reviewer
- observer

These prompt files live under `prompts/` and are loaded by `src/prompts/contracts.ts`.
