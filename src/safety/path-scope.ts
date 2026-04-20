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

export function isPathWithinScope(targetPath: string, pathScope: TeamPathScope, cwd: string): boolean {
	const absoluteTargetPath = resolve(cwd, targetPath);
	return pathScope.roots.some((root) => absoluteTargetPath === root || absoluteTargetPath.startsWith(`${root}${sep}`));
}

export function ensureWriteScope(pathScope: TeamPathScope | undefined, cwd: string): TeamPathScope {
	const normalized = normalizePathScope(pathScope, cwd);
	if (!normalized || normalized.roots.length === 0 || !normalized.allowWrite) {
		throw new Error("Write-capable workers require an explicit writable path scope.");
	}
	return normalized;
}
