export const CONSOLE_ACTIVITY_GOLDEN_LINES = [
	"— activity —",
	"╭─ process thinking [info]",
	"│ Mapping current console rendering before proposing UI changes.",
	"╰─ raw:r",
	"╭─ tool command [ok]",
	"│ $ git diff --stat main...HEAD",
	"│ src/ui/overlay.ts              | 42 +++++++++++++++++",
	"│ tests/ui/overlay.test.ts       | 18 +++++++",
	"│ … +14 lines hidden",
	"╰─ took 1.0s · raw:r",
	"╭─ final-answer [ok]",
	"│ Headline: APPROVE — no blocking issues found.",
	"│ Risks: UI wrapping tests need updates.",
	"│ Next: Safe to continue after typecheck.",
] as const;

export const CONSOLE_ACTIVITY_GOLDEN = CONSOLE_ACTIVITY_GOLDEN_LINES.join("\n");

export const CONSOLE_RAW_FALLBACK_GOLDEN_LINES = [
	"— raw —",
	"[raw] assistant chunk #0",
	"Mapping current console rendering before proposing UI changes.",
	"[raw] tool_start git diff --stat main...HEAD",
	"[raw] tool_end src/ui/overlay.ts              | 42 +++++++++++++++++",
	"[raw] tool_end tests/ui/overlay.test.ts       | 18 +++++++",
	"[raw] tool_end … +14 lines hidden",
	"[raw] assistant chunk #1",
	"<final_answer>",
	"headline: APPROVE — no blocking issues found.",
	"risks:",
	"- UI wrapping tests need updates.",
	"next_recommendation: Safe to continue after typecheck.",
	"confidence: definite",
	"</final_answer>",
] as const;

export const CONSOLE_RAW_FALLBACK_GOLDEN = CONSOLE_RAW_FALLBACK_GOLDEN_LINES.join("\n");

export const INSPECT_RECENT_ACTIVITY_GOLDEN_LINES = [
	"Recent activity",
	"• Ran grep \"buildConsoleLines\" src/ui/overlay.ts",
	"• Ran npm run typecheck",
	"• Thinking: comparing overlay width behavior",
	"• Final answer produced",
] as const;

export const INSPECT_RECENT_ACTIVITY_GOLDEN = INSPECT_RECENT_ACTIVITY_GOLDEN_LINES.join("\n");

export const NARROW_CONSOLE_ACTIVITY_GOLDEN_LINES = [
	"— activity —",
	"╭─ tool command [ok]",
	"│ $ git diff --stat main...HEAD",
	"│ src/ui/overlay.ts              | 42",
	"↳ +++++++++++++++++",
	"│ tests/ui/overlay.test.ts       | 18",
	"↳ +++++++",
	"│ … +14 lines hidden",
	"╭─ final-answer [ok]",
	"│ Headline: APPROVE — no blocking",
	"↳ issues found.",
] as const;

export const NARROW_CONSOLE_ACTIVITY_WIDTH = 44;
