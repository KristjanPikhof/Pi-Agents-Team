import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function formatBackupTimestamp(now: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Rename the file at `path` to `<timestamp>-<basename>` in the same directory.
 * Returns the new path. When a collision exists, appends `-<n>` to disambiguate.
 * Used by /team-init --force and by /team-enable / /team-disable when they
 * encounter an unparsable or schema-drifted config — the user's original file
 * is preserved before any overwrite.
 */
export function backupExisting(path: string, now: Date = new Date()): string {
	const dir = dirname(path);
	const base = basename(path);
	const timestamp = formatBackupTimestamp(now);
	let candidate = join(dir, `${timestamp}-${base}`);
	let suffix = 1;
	while (existsSync(candidate)) {
		candidate = join(dir, `${timestamp}-${suffix}-${base}`);
		suffix += 1;
	}
	renameSync(path, candidate);
	return candidate;
}
