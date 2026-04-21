/**
 * Single source of truth for the two agents-team.json version counters.
 *
 * TO BUMP A VERSION: change the constant here, nothing else. All consumers
 * (loader, scaffold, tests, docs) read from these. See the "Schema
 * versioning" section of CLAUDE.md for the rules on which counter to bump.
 *
 * - TEAM_PROJECT_SCHEMA_VERSION — the *shape contract*. Bump on breaking
 *   shape changes (renamed/moved/new required fields, re-layout). Mismatched
 *   files emit a `schema_version_mismatch` warning and fall back to built-in
 *   roles for that layer.
 *
 * - TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED — array of schemaVersion values
 *   the loader accepts. Single-valued = hard cutover (operators regenerate
 *   via `/team-init --force`). Multi-valued = transition window.
 *
 * - TEAM_SCAFFOLD_VERSION — the *scaffold content freshness marker*. Bump
 *   when `/team-init` would write different defaults even though the shape
 *   is identical. Older files keep loading; stale ones get a soft toast.
 *
 * Why this lives in TypeScript and not package.json:
 *   - The npm `version` (currently tied to a date) bumps on every release and
 *     has a different lifecycle from schema/scaffold changes.
 *   - `as const` here gives the rest of the codebase literal-typed narrowing
 *     (e.g. `TeamProjectConfigFile["schemaVersion"]: typeof TEAM_PROJECT_SCHEMA_VERSION`),
 *     which catches off-by-one mismatches at compile time. A runtime JSON read
 *     would collapse all three to `number` and lose that guarantee.
 */

export const TEAM_PROJECT_SCHEMA_VERSION = 3 as const;
export const TEAM_PROJECT_SCHEMA_VERSIONS_SUPPORTED = [3] as const;
export const TEAM_SCAFFOLD_VERSION = 3 as const;
