function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;

	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j += 1) prev[j] = j;

	for (let i = 1; i <= a.length; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1]! + 1,
				prev[j]! + 1,
				prev[j - 1]! + cost,
			);
		}
		for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
	}

	return prev[b.length]!;
}

export interface SuggestOptions {
	limit?: number;
	maxDistance?: number;
}

export function suggestTargets(input: string, candidates: Iterable<string>, options: SuggestOptions = {}): string[] {
	const normalizedInput = input.trim().toLowerCase();
	if (!normalizedInput) return [];
	const limit = options.limit ?? 2;
	const seen = new Set<string>();
	const scored: Array<{ candidate: string; distance: number }> = [];

	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		const distance = levenshtein(normalizedInput, candidate.toLowerCase());
		const maxDistance = options.maxDistance ?? Math.max(1, Math.min(3, Math.ceil(candidate.length / 2)));
		const acceptable = distance <= maxDistance || candidate.toLowerCase().startsWith(normalizedInput);
		if (!acceptable) continue;
		scored.push({ candidate, distance });
	}

	return scored
		.sort((l, r) => l.distance - r.distance || l.candidate.localeCompare(r.candidate))
		.slice(0, limit)
		.map((entry) => entry.candidate);
}

export function formatUnknownWorker(input: string, suggestions: string[]): string {
	const base = `Unknown worker: ${input}`;
	if (suggestions.length === 0) return base;
	return `${base}. Did you mean: ${suggestions.join(", ")}?`;
}
