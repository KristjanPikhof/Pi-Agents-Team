import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { TeamConfig, WorkerRuntimeState } from "../types";

const MAX_TEAM_AUTOCOMPLETE_ITEMS = 20;

type TeamAutocompleteKind = "worker" | "role";

export interface TeamAutocompleteToken {
	kind: TeamAutocompleteKind;
	query: string;
	prefix: string;
}

export interface TeamAutocompleteSources {
	getWorkers: () => WorkerRuntimeState[];
	getProfiles: () => TeamConfig["profiles"];
}

export interface TeamAutocompleteHost {
	hasUI?: boolean;
	ui?: {
		addAutocompleteProvider?: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
	};
}

function formatWorkerDescription(worker: WorkerRuntimeState): string {
	const parts = [`${worker.profileName} · ${worker.status}`];
	if (worker.currentTask?.title) parts.push(worker.currentTask.title);
	return parts.join(" · ");
}

function tokenMatches(value: string, query: string): boolean {
	const normalizedValue = value.toLowerCase();
	const normalizedQuery = query.toLowerCase();
	return normalizedQuery.length === 0 || normalizedValue.startsWith(normalizedQuery) || normalizedValue.includes(normalizedQuery);
}

export function extractTeamAutocompleteToken(textBeforeCursor: string): TeamAutocompleteToken | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])([@$])([^\s@$]*)$/);
	if (!match) return undefined;
	const marker = match[1];
	const query = match[2] ?? "";
	return {
		kind: marker === "@" ? "worker" : "role",
		query,
		prefix: `${marker}${query}`,
	};
}

export function buildWorkerAutocompleteItems(workers: WorkerRuntimeState[], query: string): AutocompleteItem[] {
	return workers
		.filter((worker) => tokenMatches(worker.workerId, query) || tokenMatches(worker.profileName, query) || tokenMatches(worker.currentTask?.title ?? "", query))
		.slice(0, MAX_TEAM_AUTOCOMPLETE_ITEMS)
		.map((worker) => ({
			value: `@${worker.workerId}`,
			label: `@${worker.workerId}`,
			description: formatWorkerDescription(worker),
		}));
}

export function buildRoleAutocompleteItems(profiles: TeamConfig["profiles"], query: string): AutocompleteItem[] {
	return profiles
		.filter((profile) => tokenMatches(profile.name, query) || tokenMatches(profile.description, query))
		.slice(0, MAX_TEAM_AUTOCOMPLETE_ITEMS)
		.map((profile) => ({
			value: `$${profile.name}`,
			label: `$${profile.name}`,
			description: profile.description || "team role",
		}));
}

function buildSuggestions(token: TeamAutocompleteToken, sources: TeamAutocompleteSources): AutocompleteSuggestions | null {
	const items = token.kind === "worker"
		? buildWorkerAutocompleteItems(sources.getWorkers(), token.query)
		: buildRoleAutocompleteItems(sources.getProfiles(), token.query);
	if (items.length === 0) return null;
	return { prefix: token.prefix, items };
}

export function createTeamAutocompleteProvider(
	current: AutocompleteProvider,
	sources: TeamAutocompleteSources,
): AutocompleteProvider {
	return {
		triggerCharacters: ["@", "$"],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const token = extractTeamAutocompleteToken(beforeCursor);
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const suggestions = buildSuggestions(token, sources);
			if (!suggestions) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return suggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			if (extractTeamAutocompleteToken(beforeCursor)) return false;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function registerTeamAutocomplete(host: TeamAutocompleteHost, sources: TeamAutocompleteSources): boolean {
	if (!host.hasUI) return false;
	if (typeof host.ui?.addAutocompleteProvider !== "function") return false;
	host.ui.addAutocompleteProvider((current) => createTeamAutocompleteProvider(current, sources));
	return true;
}
