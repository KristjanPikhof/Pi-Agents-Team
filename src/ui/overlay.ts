import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, matchesKey } from "@mariozechner/pi-tui";
import type { PersistedTeamState } from "../types";
import { buildTeamDashboardText } from "./dashboard";

export async function openTeamDashboardOverlay(ctx: ExtensionContext, state: PersistedTeamState): Promise<void> {
	if (!ctx.hasUI) {
		console.log(buildTeamDashboardText(state));
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => {
			const text = new Text(buildTeamDashboardText(state), 1, 1);
			return {
				render(width: number): string[] {
					return text.render(width);
				},
				invalidate(): void {
					text.invalidate();
				},
				handleInput(data: string): void {
					if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
						done();
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 },
		},
	);
}
