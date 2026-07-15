import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");

function runNpm(args: string[], cwd: string) {
	const npmCli = process.env.npm_execpath;
	const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
	const commandArgs = npmCli ? [npmCli, ...args] : args;
	const result = spawnSync(command, commandArgs, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
	});
	assert.equal(
		result.status,
		0,
		`npm ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	return result;
}

test("a clean publish artifact installs and imports in an offline consumer", { timeout: 120_000 }, async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-agents-team-publish-"));
	const cleanSource = join(temporaryRoot, "source");
	const artifacts = join(temporaryRoot, "artifacts");
	const consumer = join(temporaryRoot, "consumer");

	try {
		await Promise.all([mkdir(cleanSource), mkdir(artifacts), mkdir(consumer)]);

		for (const file of ["package.json", "README.md", "LICENSE", "tsconfig.json", "tsconfig.publish.json"]) {
			await cp(join(projectRoot, file), join(cleanSource, file));
		}
		for (const directory of ["extensions", "src", "prompts", "profiles", "scripts"]) {
			await cp(join(projectRoot, directory), join(cleanSource, directory), { recursive: true });
		}
		await symlink(join(projectRoot, "node_modules"), join(cleanSource, "node_modules"), "junction");
		assert.equal(existsSync(join(cleanSource, "dist")), false, "publish build must start without dist");

		runNpm(["pack", "--pack-destination", artifacts, "--ignore-scripts=false"], cleanSource);
		const tarballs = (await readdir(artifacts)).filter((entry) => entry.endsWith(".tgz"));
		assert.equal(tarballs.length, 1, "npm pack should create exactly one tarball");

		await writeFile(
			join(consumer, "package.json"),
			JSON.stringify({
				name: "publish-contract-consumer",
				private: true,
				type: "module",
				dependencies: {
					"@earendil-works/pi-coding-agent": "0.80.6",
					"@earendil-works/pi-tui": "0.80.6",
				},
			}),
		);
		const tarball = join(artifacts, tarballs[0]!);
		runNpm(
			["install", "--offline", "--ignore-scripts", "--no-package-lock", "--no-save", tarball],
			consumer,
		);

		const installedPackage = join(consumer, "node_modules", "pi-agents-team");
		assert.equal(existsSync(join(installedPackage, "dist", "extensions", "index.js")), true);
		assert.equal(existsSync(join(installedPackage, "src")), false, "source must not leak into the package");
		const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as {
			version?: string;
		};
		const sourceManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
			version?: string;
		};
		assert.equal(installedManifest.version, sourceManifest.version);
		for (const piPackage of ["pi-coding-agent", "pi-tui"]) {
			const manifest = JSON.parse(
				await readFile(join(consumer, "node_modules", "@earendil-works", piPackage, "package.json"), "utf8"),
			) as { version?: string };
			assert.equal(manifest.version, "0.80.6", `${piPackage} consumer baseline drifted`);
		}

		const imported = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", 'import extension from "pi-agents-team"; if (typeof extension !== "function") process.exit(1)'],
			{ cwd: consumer, encoding: "utf8" },
		);
		assert.equal(
			imported.status,
			0,
			`consumer import failed for ${basename(tarball)}\nstdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
