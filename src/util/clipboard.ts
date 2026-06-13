import { spawn } from "node:child_process";
import { platform } from "node:os";

interface ClipboardProvider {
	command: string;
	args: string[];
}

function pickProviders(): ClipboardProvider[] {
	switch (platform()) {
		case "darwin":
			return [{ command: "pbcopy", args: [] }];
		case "win32":
			return [{ command: "clip.exe", args: [] }];
		default:
			return [
				{ command: "wl-copy", args: [] },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
			];
	}
}

async function tryProvider(provider: ClipboardProvider, text: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(provider.command, provider.args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.on("error", reject);
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${provider.command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		child.stdin?.end(text, "utf8");
	});
}

export async function copyToClipboard(text: string): Promise<void> {
	const providers = pickProviders();
	const errors: string[] = [];
	for (const provider of providers) {
		try {
			await tryProvider(provider, text);
			return;
		} catch (error) {
			errors.push(`${provider.command}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`No clipboard provider available. Tried: ${errors.join("; ")}`);
}
