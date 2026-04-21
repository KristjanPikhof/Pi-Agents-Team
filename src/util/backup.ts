import { constants, copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Seconds-granularity timestamp used in backup filenames. Seconds are included
 * so two commands fired inside the same minute don't collide — the suffix loop
 * in `backupExisting` then only handles same-second collisions (rare, bounded).
 */
export function formatBackupTimestamp(now: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Copy the file at `path` to `<timestamp>-<basename>` in the same directory,
 * returning the backup path. The ORIGINAL file is preserved on disk — callers
 * are responsible for any subsequent atomic overwrite via `atomicWriteFileSync`.
 *
 * Safety properties:
 *  - `copyFileSync(..., COPYFILE_EXCL)` guarantees we never silently overwrite
 *    a sibling backup. Two concurrent `/team-init --force` runs that land in
 *    the same second race on the timestamped name, and the loser gets a
 *    suffix instead of clobbering the winner's backup.
 *  - The original file stays in place the whole time. Pre-fix, backup used
 *    `renameSync` which atomically moved the original away; a crash between
 *    the rename and the new write left the user with no active config.
 *  - Bounded retry: 100 same-second suffixes is the ceiling, then we throw
 *    rather than loop forever.
 */
export function backupExisting(path: string, now: Date = new Date()): string {
	const dir = dirname(path);
	const base = basename(path);
	const timestamp = formatBackupTimestamp(now);
	let candidate = join(dir, `${timestamp}-${base}`);
	let suffix = 1;
	while (true) {
		try {
			copyFileSync(path, candidate, constants.COPYFILE_EXCL);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (suffix > 100) {
				throw new Error(`Could not allocate a unique backup name under ${dir} (100 same-second collisions).`);
			}
			candidate = join(dir, `${timestamp}-${suffix}-${base}`);
			suffix += 1;
		}
	}
}

/**
 * Write `body` to `path` atomically: stage to `<path>.tmp.<pid>.<ts>`, fsync
 * the write by virtue of `renameSync` being atomic within a filesystem, then
 * rename into place. A crash before the rename leaves the original file
 * untouched. Used by `/team-init` and `/team-toggle` to avoid the
 * `writeFileSync(path, ...)` truncate-then-write window that would leave the
 * config empty on ctrl-C mid-write.
 */
export function atomicWriteFileSync(path: string, body: string, options?: { mode?: number }): void {
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, body, options);
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* tmp already gone — fine */
		}
		throw error;
	}
}
