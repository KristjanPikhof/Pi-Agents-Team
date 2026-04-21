import { resolve, sep } from "node:path";
import type { TeamPathScope } from "../types";

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

export function isPathWithinScope(targetPath: string, pathScope: TeamPathScope, cwd: string): boolean {
	const absoluteTargetPath = resolve(cwd, targetPath);
	return pathScope.roots.some((root) => isAbsolutePathWithinRoot(absoluteTargetPath, root));
}

export function isPathWithinProjectRoot(targetPath: string, projectRoot: string, cwd: string): boolean {
	return isAbsolutePathWithinRoot(resolve(cwd, targetPath), resolve(projectRoot));
}

export function isPathScopeWithinProjectRoot(pathScope: TeamPathScope | undefined, projectRoot: string, cwd: string): boolean {
	const normalized = normalizePathScope(pathScope, cwd);
	if (!normalized) return true;
	const absoluteProjectRoot = resolve(projectRoot);
	return normalized.roots.every((root) => isAbsolutePathWithinRoot(root, absoluteProjectRoot));
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
