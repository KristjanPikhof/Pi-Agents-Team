export interface FinalAnswerSummaryFields {
	headline?: string;
	risks?: string[];
	nextRecommendation?: string;
}

const FINAL_ANSWER_PATTERN = /<final[_\s-]?answer>([\s\S]*?)<\/final[_\s-]?answer>/i;

export function extractFinalAnswer(text: string): string | undefined {
	const match = FINAL_ANSWER_PATTERN.exec(text);
	if (!match) return undefined;
	const content = match[1]?.trim();
	return content && content.length > 0 ? content : undefined;
}

export function parseFinalAnswerSummaryFields(text: string): FinalAnswerSummaryFields {
	const headline = /^headline:\s*(.+)$/im.exec(text)?.[1]?.trim();
	const nextRecommendation = /^next_recommendation:\s*(.+)$/im.exec(text)?.[1]?.trim();
	const risksBlock = /^risks:\s*$(?<body>(?:\s*[-*]\s+.+\n?)*)/im.exec(text)?.groups?.body ?? "";
	const risks = risksBlock
		.split("\n")
		.map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
	return {
		...(headline ? { headline } : {}),
		...(risks.length > 0 ? { risks } : {}),
		...(nextRecommendation ? { nextRecommendation } : {}),
	};
}
