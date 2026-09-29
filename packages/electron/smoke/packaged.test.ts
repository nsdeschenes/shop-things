import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const release = join(projectRoot, "release");
const sourceMigrations = join(projectRoot, "packages", "db", "migrations");
const runtimeScript = fileURLToPath(new URL("../scripts/smoke-packaged.ts", import.meta.url));
const packageName = "Shop Things";

interface PackagedTarget {
  directory: string;
  executable: string[];
  resources: string[];
  addon: string;
  installer: RegExp;
}

const targets: Record<string, PackagedTarget> = {
  "darwin-arm64": {
    directory: "mac-arm64",
    executable: ["Shop Things.app", "Contents", "MacOS", packageName],
    resources: ["Shop Things.app", "Contents", "Resources"],
    addon: "database-darwin-arm64/turso.darwin-arm64.node",
    installer: /-arm64\.dmg$/,
  },
  "win32-x64": {
    directory: "win-unpacked",
    executable: [`${packageName}.exe`],
    resources: ["resources"],
    addon: "database-win32-x64-msvc/turso.win32-x64-msvc.node",
    installer: /\.exe$/,
  },
  "linux-x64": {
    directory: "linux-unpacked",
    executable: ["shop-things"],
    resources: ["resources"],
    addon: "database-linux-x64-gnu/turso.linux-x64-gnu.node",
    installer: /_amd64\.deb$/,
  },
  "linux-arm64": {
    directory: "linux-arm64-unpacked",
    executable: ["shop-things"],
    resources: ["resources"],
    addon: "database-linux-arm64-gnu/turso.linux-arm64-gnu.node",
    installer: /_arm64\.deb$/,
  },
};

async function filesUnder(folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

test("verifies the packaged database, migrations, native addon, and installer", async () => {
  const platform = process.env.SMOKE_PLATFORM ?? process.platform;
  const arch = process.env.SMOKE_ARCH ?? process.arch;
  const target = targets[`${platform}-${arch}`];
  assert.ok(target, `Unsupported packaged target: ${platform}-${arch}`);
  assert.equal(process.platform, platform, "Smoke must run on the target OS");
  assert.equal(process.arch, arch, "Smoke must run on the target architecture");
  const diagnosticReport = process.report?.getReport();
  const header =
    diagnosticReport && "header" in diagnosticReport ? diagnosticReport.header : undefined;
  const glibcVersion =
    platform === "linux" &&
    typeof header === "object" &&
    header !== null &&
    "glibcVersionRuntime" in header
      ? header.glibcVersionRuntime
      : null;
  if (platform === "linux") {
    assert.ok(glibcVersion, "Linux package smoke requires glibc");
  }

  const executable = join(release, target.directory, ...target.executable);
  const resources = join(release, target.directory, ...target.resources);
  const addon = join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "@tursodatabase",
    target.addon,
  );
  assert.ok((await stat(executable)).isFile(), `Missing packaged executable: ${executable}`);
  assert.ok((await stat(join(resources, "app.asar"))).isFile(), "Missing app.asar");
  assert.ok((await stat(addon)).isFile(), `Missing native addon: ${addon}`);

  const sourceFiles = await filesUnder(sourceMigrations);
  const packagedFolder = join(resources, "migrations");
  const packagedFiles = await filesUnder(packagedFolder);
  assert.deepEqual(
    packagedFiles.map((path) => relative(packagedFolder, path)),
    sourceFiles.map((path) => relative(sourceMigrations, path)),
    "Packaged migration tree differs from the checked-in tree",
  );
  for (const source of sourceFiles) {
    assert.deepEqual(
      await readFile(join(packagedFolder, relative(sourceMigrations, source))),
      await readFile(source),
      `Packaged migration differs: ${source}`,
    );
  }

  const installers = (await readdir(release)).filter((name) => target.installer.test(name));
  assert.equal(installers.length, 1, `Expected one installer for ${platform}-${arch}`);

  const result = spawnSync(executable, ["--experimental-strip-types", runtimeScript, resources], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.equal(
    result.status,
    0,
    `Packaged database smoke failed:\n${result.stdout}\n${result.stderr}`,
  );
  const databaseResult = JSON.parse(result.stdout);

  const report = {
    target: `${platform}-${arch}`,
    glibcVersion,
    installer: installers[0],
    executable: relative(release, executable),
    nativeAddon: relative(release, addon),
    packagedMigrations: packagedFiles.map((path) => relative(packagedFolder, path)),
    ...databaseResult,
  };
  const reportPath = process.env.SMOKE_REPORT_PATH;

  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}, 60_000);
