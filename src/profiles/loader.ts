import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getDefaultProfile, DEFAULT_PROFILE_SPECS } from "./default-profiles";
import type { TeamProfileSpec, ThinkingLevel, WorkerExtensionMode, WorkerWritePolicy } from "../types";

interface ProfileFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string;
	prompt?: string;
	extensionMode?: WorkerExtensionMode;
	writePolicy?: WorkerWritePolicy;
	canSpawnWorkers?: boolean | string;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILES_DIR = resolve(moduleDir, "../../profiles");

function parseBoolean(value: ProfileFrontmatter["canSpawnWorkers"]): boolean {
	if (typeof value === "boolean") return value;
	return value === "true";
}

export function loadProfiles(profilesDir = DEFAULT_PROFILES_DIR): TeamProfileSpec[] {
	const profileMap = new Map(DEFAULT_PROFILE_SPECS.map((profile) => [profile.name, { ...profile }]));
	if (!existsSync(profilesDir)) {
		return Array.from(profileMap.values());
	}

	for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const content = readFileSync(resolve(profilesDir, entry.name), "utf8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown> & ProfileFrontmatter>(content);
		if (!frontmatter.name || !frontmatter.description || !frontmatter.prompt) continue;

		const fallback = getDefaultProfile(frontmatter.name);
		profileMap.set(frontmatter.name, {
			name: frontmatter.name,
			description: frontmatter.description,
			model: frontmatter.model ?? fallback?.model,
			thinkingLevel: frontmatter.thinking ?? fallback?.thinkingLevel ?? "medium",
			tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean) ?? fallback?.tools ?? [],
			promptPath: frontmatter.prompt,
			extensionMode: frontmatter.extensionMode ?? fallback?.extensionMode ?? "worker-minimal",
			writePolicy: frontmatter.writePolicy ?? fallback?.writePolicy ?? "read-only",
			pathScope: fallback?.pathScope,
			canSpawnWorkers: parseBoolean(frontmatter.canSpawnWorkers) || fallback?.canSpawnWorkers || false,
		});
	}

	return Array.from(profileMap.values());
}

export function resolveProfile(profileName: string, profilesDir = DEFAULT_PROFILES_DIR): TeamProfileSpec {
	const profile = loadProfiles(profilesDir).find((item) => item.name === profileName);
	if (!profile) {
		throw new Error(`Unknown team profile: ${profileName}`);
	}
	return profile;
}
