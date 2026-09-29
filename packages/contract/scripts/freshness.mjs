import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const require = createRequire(resolve(packageRoot, "package.json"));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return lists.flat();
}

export async function fingerprint() {
  const hash = createHash("sha256");
  const sources = [
    ...(await files(resolve(packageRoot, "src"))),
    ...(await files(resolve(packageRoot, "scripts"))),
    resolve(packageRoot, "package.json"),
    resolve(workspaceRoot, "pnpm-lock.yaml"),
    resolve(workspaceRoot, "pnpm-workspace.yaml"),
  ];
  let config = resolve(packageRoot, "tsconfig.json");
  while (config) {
    sources.push(config);
    const parsed = JSON.parse(await readFile(config, "utf8"));
    config = parsed.extends ? resolve(dirname(config), parsed.extends) : null;
  }

  for (const path of sources.sort((a, b) => a.localeCompare(b))) {
    hash.update(relative(workspaceRoot, path));
    hash.update(await readFile(path));
  }

  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).sort()) {
    const path = require.resolve(`${name}/package.json`);
    hash.update(name);
    hash.update(await readFile(path));
  }

  return hash.digest("hex");
}

export async function artifactHashes() {
  const hash = {};
  for (const path of (await files(resolve(packageRoot, "dist"))).sort()) {
    if (path.endsWith("/fingerprint.json")) {
      continue;
    }

    hash[relative(packageRoot, path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }

  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  for (const entry of Object.values(manifest.exports)) {
    for (const path of Object.values(entry)) {
      await readFile(resolve(packageRoot, path));
    }
  }

  return hash;
}

export async function checkFreshness() {
  const recorded = JSON.parse(
    await readFile(resolve(packageRoot, "dist/fingerprint.json"), "utf8"),
  );
  if (
    recorded.source !== (await fingerprint()) ||
    JSON.stringify(recorded.artifacts) !== JSON.stringify(await artifactHashes())
  ) {
    throw new Error("Contract output is stale or incomplete; rebuild @shop-things/contract.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkFreshness();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
