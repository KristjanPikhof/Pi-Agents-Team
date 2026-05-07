// ANSI styling helpers for the /team overlay. Pi-tui's `visibleWidth` strips
// these escape sequences before measuring, so wrapping content in any of these
// helpers does not affect width math. Always close with RESET.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(open: string, text: string): string {
	if (!text) return text;
	return `${ESC}${open}m${text}${RESET}`;
}

export const bold = (text: string): string => wrap("1", text);
export const dim = (text: string): string => wrap("2", text);
export const muted = (text: string): string => wrap("38;5;244", text); // soft gray
export const accent = (text: string): string => wrap("38;5;75", text); // cyan-blue
export const accentBold = (text: string): string => wrap("1;38;5;75", text);
export const success = (text: string): string => wrap("38;5;114", text); // green
export const successBold = (text: string): string => wrap("1;38;5;114", text);
export const warning = (text: string): string => wrap("38;5;179", text); // amber
export const warningBold = (text: string): string => wrap("1;38;5;179", text);
export const danger = (text: string): string => wrap("38;5;167", text); // red
export const dangerBold = (text: string): string => wrap("1;38;5;167", text);
export const inverse = (text: string): string => wrap("7", text);

// Box-drawing characters (each 1 cell wide). Use these instead of full borders
// where possible to keep width math simple.
export const FRAME = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeRight: "├",
	teeLeft: "┤",
	sectionMark: "▌",
} as const;

// Strip our own ANSI styling from a string. Used by mocks/tests that compare
// against plain content.
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
