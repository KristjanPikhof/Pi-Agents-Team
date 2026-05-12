import type { WorkerUsageStats } from "../types";

/**
 * Format token counts for narrow status surfaces.
 *
 * Semantics: values below 1000 stay raw; `k` is thousands (1000),
 * `m` is millions (1000000); suffixes are lowercase. One decimal is kept
 * only when it adds signal, so threshold values remain compact (1000 -> 1k).
 */
export function formatCompactTokenCount(value: number): string {
	if (value >= 1_000_000) return `${formatScaled(value / 1_000_000)}m`;
	if (value >= 1_000) return `${formatScaled(value / 1_000)}k`;
	return `${value}`;
}

export function formatContextBudget(usage: WorkerUsageStats): string | undefined {
	const percent = usage.contextPercent;
	const remaining = usage.contextRemainingTokens;
	if (percent === undefined && remaining === undefined) return undefined;

	const parts: string[] = [];
	if (percent !== undefined) {
		const window = usage.contextWindow !== undefined ? `/${formatCompactTokenCount(usage.contextWindow)}` : "";
		parts.push(`ctx=${formatPercent(percent)}%${window}`);
	}
	if (remaining !== undefined) parts.push(`rem=${formatCompactTokenCount(remaining)}`);
	return parts.join(" ");
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatScaled(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}
