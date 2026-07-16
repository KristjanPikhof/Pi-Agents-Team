import { DEFAULT_TEAM_CONFIG } from "../config.js";
import type { TeamProfileSpec } from "../types.js";

export const DEFAULT_PROFILE_SPECS: TeamProfileSpec[] = DEFAULT_TEAM_CONFIG.profiles.map((profile) => ({ ...profile }));

export function getDefaultProfile(profileName: string): TeamProfileSpec | undefined {
	return DEFAULT_PROFILE_SPECS.find((profile) => profile.name === profileName);
}
