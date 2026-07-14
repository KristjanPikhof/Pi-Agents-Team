import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, "dist");
const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");

async function copyTree(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(source, destination);
    } else if (entry.isFile()) {
      await copyFile(source, destination);
    } else {
      throw new Error(`Unsupported asset entry: ${source}`);
    }
  }
}

await rm(distDir, { recursive: true, force: true });

const compilation = spawnSync(
  process.execPath,
  [tscPath, "-p", join(projectRoot, "tsconfig.publish.json")],
  { cwd: projectRoot, stdio: "inherit" },
);

if (compilation.error) {
  throw compilation.error;
}
if (compilation.status !== 0) {
  process.exit(compilation.status ?? 1);
}

await copyTree(join(projectRoot, "prompts"), join(distDir, "prompts"));
await copyTree(join(projectRoot, "profiles"), join(distDir, "profiles"));
