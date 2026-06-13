import { sanitizeTerminalText } from "./theme";

export const DISPLAY_TRANSCRIPT_BYTE_CAP = 256 * 1024;
export const DISPLAY_TRANSCRIPT_LINE_CAP = 4000;

export function formatRetainedTranscript(text: string | undefined): string {
	const safe = sanitizeTerminalText(text ?? "").trim();
	if (!safe) return "";
	const alreadyNoted = /^\[transcript truncated:/i.test(safe);
	const lines = safe.split("\n");
	let retained = safe;
	let droppedLines = 0;
	if (lines.length > DISPLAY_TRANSCRIPT_LINE_CAP) {
		droppedLines = lines.length - DISPLAY_TRANSCRIPT_LINE_CAP;
		retained = lines.slice(-DISPLAY_TRANSCRIPT_LINE_CAP).join("\n");
	}
	let start = 0;
	while (Buffer.byteLength(retained.slice(start), "utf8") > DISPLAY_TRANSCRIPT_BYTE_CAP) {
		start += Math.max(1, Math.ceil((Buffer.byteLength(retained.slice(start), "utf8") - DISPLAY_TRANSCRIPT_BYTE_CAP) / 4));
	}
	const droppedBytes = start > 0 ? Buffer.byteLength(retained.slice(0, start), "utf8") : 0;
	if (start > 0) retained = retained.slice(start);
	if ((alreadyNoted && /^\[transcript truncated:/i.test(retained)) || (droppedBytes === 0 && droppedLines === 0)) return retained;
	const parts = [
		droppedBytes > 0 ? `${droppedBytes.toLocaleString()} bytes` : undefined,
		droppedLines > 0 ? `${droppedLines.toLocaleString()} lines` : undefined,
	].filter((part): part is string => Boolean(part));
	return `[transcript truncated: showing retained tail; omitted ${parts.join(" / ")}]\n${retained}`;
}
