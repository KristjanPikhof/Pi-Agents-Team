import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { TeamPathScope } from "../types";

/**
 * Resolve `path` through symlinks if it exists; otherwise return the lexical
 * resolution. Used for containment checks where we want to detect "lexically
 * inside root but the real inode is outside" (a symlink-escape). For paths that
 * don't yet exist (pathScope roots may be created at runtime by the worker)
 * the lexical result is the only safe answer.
 */
function realpathOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export function normalizePathScope(pathScope: TeamPathScope | undefined, cwd: string): TeamPathScope | undefined {
	if (!pathScope) return undefined;
	const roots = Array.from(new Set(pathScope.roots.map((root) => resolve(cwd, root))));
	return {
		roots,
		allowReadOutsideRoots: pathScope.allowReadOutsideRoots,
		allowWrite: pathScope.allowWrite,
	};
}

function isAbsolutePathWithinRoot(targetPath: string, root: string): boolean {
	return targetPath === root || targetPath.startsWith(`${root}${sep}`);
}

/**
 * Containment check that also catches symlink-based escapes. Returns true when
 * both the lexical path AND the realpath (when it exists) are inside the real
 * root. A hostile repo could commit a symlink under the project root pointing
 * at an absolute path elsewhere (e.g. `project/linked -> ~/.ssh`); the lexical
 * check passes because the symlink file itself lives under project, but the
 * inode is outside — this function rejects that.
 */
function isAbsolutePathWithinRootWithRealpath(targetPath: string, root: string): boolean {
	if (!isAbsolutePathWithinRoot(targetPath, root)) return false;
	const realTarget = realpathOrSelf(targetPath);
	const realRoot = realpathOrSelf(root);
	if (realTarget === targetPath && realRoot === root) return true;
	return isAbsolutePathWithinRoot(realTarget, realRoot);
}

export function isPathWithinScope(targetPath: string, pathScope: TeamPathScope, cwd: string): boolean {
	const absoluteTargetPath = resolve(cwd, targetPath);
	return pathScope.roots.some((root) => isAbsolutePathWithinRootWithRealpath(absoluteTargetPath, root));
}

export function isPathWithinProjectRoot(targetPath: string, projectRoot: string, cwd: string): boolean {
	return isAbsolutePathWithinRootWithRealpath(resolve(cwd, targetPath), resolve(projectRoot));
}

export function isPathScopeWithinProjectRoot(pathScope: TeamPathScope | undefined, projectRoot: string, cwd: string): boolean {
	const normalized = normalizePathScope(pathScope, cwd);
	if (!normalized) return true;
	const absoluteProjectRoot = resolve(projectRoot);
	return normalized.roots.every((root) => isAbsolutePathWithinRootWithRealpath(root, absoluteProjectRoot));
}

export function isPathScopeNarrowerOrEqual(
	candidate: TeamPathScope | undefined,
	baseline: TeamPathScope | undefined,
	cwd: string,
): boolean {
	const normalizedCandidate = normalizePathScope(candidate, cwd);
	if (!normalizedCandidate) return baseline === undefined;
	const normalizedBaseline = normalizePathScope(baseline, cwd);
	if (!normalizedBaseline) return true;
	if (normalizedCandidate.allowWrite && !normalizedBaseline.allowWrite) return false;
	if (normalizedCandidate.allowReadOutsideRoots && !normalizedBaseline.allowReadOutsideRoots) return false;
	return normalizedCandidate.roots.every((candidateRoot) =>
		normalizedBaseline.roots.some((baselineRoot) => isAbsolutePathWithinRoot(candidateRoot, baselineRoot)),
	);
}

export function ensureWriteScope(pathScope: TeamPathScope | undefined, cwd: string): TeamPathScope {
	const normalized = normalizePathScope(pathScope, cwd);
	if (!normalized || normalized.roots.length === 0 || !normalized.allowWrite) {
		throw new Error("Write-capable workers require an explicit writable path scope.");
	}
	return normalized;
}
