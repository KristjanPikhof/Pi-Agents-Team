import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const PACK_TIMEOUT_MS = 45_000;
const OFFLINE_INSTALL_TIMEOUT_MS = 45_000;
const CONSUMER_IMPORT_TIMEOUT_MS = 15_000;
const SETUP_CLEANUP_MARGIN_MS = 30_000;
const PACKAGE_TEST_TIMEOUT_MS = 150_000;
const BUDGETED_TEST_DURATION_MS =
	PACK_TIMEOUT_MS + OFFLINE_INSTALL_TIMEOUT_MS + CONSUMER_IMPORT_TIMEOUT_MS + SETUP_CLEANUP_MARGIN_MS;

function runNpm(args: string[], cwd: string, timeoutMs: number) {
	const npmCli = process.env.npm_execpath;
	const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
	const commandArgs = npmCli ? [npmCli, ...args] : args;
	const result = spawnSync(command, commandArgs, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
		timeout: timeoutMs,
	});
	assert.equal(
		result.status,
		0,
		`npm ${args.join(" ")} failed (timeout=${timeoutMs}ms; status=${String(result.status)}; signal=${String(result.signal)}; error=${result.error?.message ?? "none"})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	return result;
}

test("the package publish timeout covers every subprocess budget and filesystem cleanup", () => {
	assert.ok(
		PACKAGE_TEST_TIMEOUT_MS > BUDGETED_TEST_DURATION_MS,
		`outer timeout (${PACKAGE_TEST_TIMEOUT_MS}ms) must exceed pack (${PACK_TIMEOUT_MS}ms) + offline install (${OFFLINE_INSTALL_TIMEOUT_MS}ms) + consumer import (${CONSUMER_IMPORT_TIMEOUT_MS}ms) + setup/cleanup (${SETUP_CLEANUP_MARGIN_MS}ms)`,
	);
});

test("package docs pin Pi 0.80.6 and separate source, compiled, and published validation", async () => {
	const [readme, contributing, operations, architecture] = await Promise.all(
		["README.md", "CONTRIBUTING.md", "docs/operations.md", "docs/architecture.md"].map((path) =>
			readFile(join(projectRoot, path), "utf8"),
		),
	);
	const combinedDocumentation = [readme, contributing, operations, architecture].join("\n");

	assert.doesNotMatch(combinedDocumentation, /\b0\.80\.7\b/);
	assert.doesNotMatch(combinedDocumentation, /pi -e \.\/extensions\/index\.ts -p ["']\/team["']/);
	assert.doesNotMatch(combinedDocumentation, /That smoke command exercises the shipped package entrypoint/);
	assert.match(readme, /This checks the source path only; it does not validate the compiled or published package entrypoint\./);
	assert.match(
		contributing,
		/Development validation uses exactly Pi `0\.80\.6`[\s\S]*Do not use `-p "\/team"` as an overlay check/,
	);
	assert.match(
		operations,
		/Check the source shim during development:[\s\S]*Check the compiled Pi entrypoint:[\s\S]*Check the published package contract/,
	);
	assert.match(architecture, /Repository development dependencies and validation use exactly Pi `0\.80\.6`/);
});

test("a clean publish artifact installs and imports in an offline consumer", { timeout: PACKAGE_TEST_TIMEOUT_MS }, async () => {
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

		runNpm(["pack", "--pack-destination", artifacts, "--ignore-scripts=false"], cleanSource, PACK_TIMEOUT_MS);
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
			OFFLINE_INSTALL_TIMEOUT_MS,
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
			{ cwd: consumer, encoding: "utf8", timeout: CONSUMER_IMPORT_TIMEOUT_MS },
		);
		assert.equal(
			imported.status,
			0,
			`consumer import failed for ${basename(tarball)} (timeout=${CONSUMER_IMPORT_TIMEOUT_MS}ms; status=${String(imported.status)}; signal=${String(imported.signal)}; error=${imported.error?.message ?? "none"})\nstdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
