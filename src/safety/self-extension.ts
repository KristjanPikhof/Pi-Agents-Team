import { realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_EXTENSION_PACKAGE_NAME = "pi-agents-team";
const SOURCE_ENTRYPOINTS = [
	"extensions/index.ts",
	"extensions/pi-agent-team/index.ts",
] as const;
const COMPILED_ENTRYPOINTS = [
	"dist/extensions/index.js",
	"dist/extensions/pi-agent-team/index.js",
] as const;

function realpathOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * Derive self-entry candidates from this module's source or compiled location.
 * Source modules live at <package>/src/safety; published modules live at
 * <package>/dist/src/safety. The module extension distinguishes those verified
 * forms without treating a source package directory named `dist` as emitted
 * output. Keeping both layouts in the candidate set lets a source checkout
 * reject its generated dist entry without requiring dist to exist, while an
 * installed package rejects its compiled entry.
 */
export function getOrchestratorSelfEntryPaths(modulePath = fileURLToPath(import.meta.url)): ReadonlySet<string> {
	const moduleFilePath = modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath;
	const layoutRoot = resolve(dirname(moduleFilePath), "../..");
	const packageRoot = extname(moduleFilePath) === ".js" ? dirname(layoutRoot) : layoutRoot;
	const entrypoints = [...SOURCE_ENTRYPOINTS, ...COMPILED_ENTRYPOINTS];
	return new Set(
		entrypoints.flatMap((entrypoint) => {
			const path = resolve(packageRoot, entrypoint);
			const realPath = realpathOrSelf(path);
			return realPath === path ? [path] : [path, realPath];
		}),
	);
}

function isSelfPackageExtensionSource(source: string): boolean {
	const spec = source.startsWith("npm:") ? source.slice("npm:".length) : source;
	const escapedName = SELF_EXTENSION_PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`^${escapedName}(?:@[^/]+)?(?:/|$)`).test(spec)) return true;
	return getExtensionSourceTail(source) === SELF_EXTENSION_PACKAGE_NAME;
}

function getExtensionSourceTail(source: string): string | undefined {
	let spec = source.trim();
	if (spec.startsWith("npm:")) spec = spec.slice("npm:".length);
	if (spec.startsWith("git+")) spec = spec.slice("git+".length);
	if (spec.startsWith("git:")) spec = spec.slice("git:".length);
	try {
		const url = new URL(spec);
		spec = url.pathname;
	} catch {
		const scpLikeMatch = /^[^@/\s]+@[^:\s]+:(.+)$/.exec(spec);
		if (scpLikeMatch?.[1]) spec = scpLikeMatch[1];
	}
	spec = spec.split(/[?#]/, 1)[0] ?? spec;
	const tail = spec.split(/[\\/]/).filter((part) => part.length > 0).at(-1);
	return tail?.replace(/\.git$/i, "").replace(/@[^@/]+$/, "");
}

function isPathLikeExtensionSource(source: string): boolean {
	if (isAbsolute(source) || /^[a-zA-Z]:[\\/]/.test(source)) return true;
	if (source === "." || source === ".." || source.startsWith("./") || source.startsWith("../")) return true;
	if (source === "extensions") return true;
	if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("http://") || source.startsWith("https://")) return false;
	if (source.startsWith("@")) return false;
	return /[\\/]/.test(source);
}

function isSameOrAncestorPath(candidate: string, target: string): boolean {
	const rel = relative(candidate, target);
	return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

export function isRecursiveOrchestratorExtensionSource(
	source: string,
	baseDir: string,
	modulePath = fileURLToPath(import.meta.url),
): boolean {
	const trimmed = source.trim();
	if (trimmed.length === 0) return false;
	if (isSelfPackageExtensionSource(trimmed)) return true;
	if (!isPathLikeExtensionSource(trimmed)) return false;

	const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
	const realResolved = realpathOrSelf(resolved);
	return [...getOrchestratorSelfEntryPaths(modulePath)].some(
		(selfPath) => isSameOrAncestorPath(resolved, selfPath) || isSameOrAncestorPath(realResolved, selfPath),
	);
}
