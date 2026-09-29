import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const release = join(projectRoot, "release");
const runtimeScript = fileURLToPath(new URL("../scripts/smoke-packaged.ts", import.meta.url));
const installerPattern = /_amd64\.deb$/;
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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

  return files.sort();
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("proves the shipped Linux glibc x64 backend and retains commit/artifact evidence", async () => {
  const reportPath = process.env.SMOKE_REPORT_PATH ?? join(release, "package-smoke.json");
  await mkdir(dirname(reportPath), { recursive: true });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    executionEnvironment: process.env.SMOKE_EXECUTION_ENVIRONMENT ?? "native Linux glibc x64",
    target: "linux-x64-glibc",
    deferred: ["renderer/preload/IPC GUI journey", "macOS arm64", "Windows x64", "Linux arm64"],
  };
  let failure: unknown;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    report.commit = git(["rev-parse", "HEAD"]);
    report.dirtyTracked = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
    assert.equal(report.dirtyTracked, false, "Acceptance requires clean committed tracked sources");
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "x64");
    const diagnostic = process.report.getReport();
    const header =
      typeof diagnostic === "object" && diagnostic !== null && "header" in diagnostic
        ? diagnostic.header
        : undefined;
    assert.ok(
      typeof header === "object" &&
        header !== null &&
        "glibcVersionRuntime" in header &&
        header.glibcVersionRuntime,
      "Linux acceptance requires glibc",
    );
    report.glibcVersion = header.glibcVersionRuntime;
    const executable = join(release, "linux-unpacked/shop-things");
    const resources = join(release, "linux-unpacked/resources");
    const archive = join(resources, "app.asar");
    const addon = join(
      resources,
      "app.asar.unpacked/node_modules/@tursodatabase/database-linux-x64-gnu/turso.linux-x64-gnu.node",
    );
    for (const path of [executable, archive, addon]) {
      assert.ok((await stat(path)).isFile(), `Missing packaged resource: ${path}`);
    }

    const installers = (await readdir(release)).filter((name) => installerPattern.test(name));
    assert.equal(installers.length, 1, "Expected one Linux x64 installer");
    const installer = join(release, installers[0]!);
    report.artifacts = await Promise.all(
      [executable, archive, addon, installer].map(async (path) => ({
        path: relative(release, path),
        sha256: await digest(path),
      })),
    );
    const sourceMigrations = join(projectRoot, "packages/db/migrations");
    const packagedMigrations = join(resources, "migrations");
    const sourceFiles = await filesUnder(sourceMigrations);
    const shippedFiles = await filesUnder(packagedMigrations);
    assert.deepEqual(
      shippedFiles.map((path) => relative(packagedMigrations, path)),
      sourceFiles.map((path) => relative(sourceMigrations, path)),
    );
    report.migrations = await Promise.all(
      sourceFiles.map(async (path) => {
        const shipped = join(packagedMigrations, relative(sourceMigrations, path));
        assert.deepEqual(await readFile(shipped), await readFile(path));
        return { path: relative(packagedMigrations, shipped), sha256: await digest(shipped) };
      }),
    );
    const inventoryFiles: { path: string; sha256: string }[] = [];
    for (const [folder, destination] of [
      ["electron", "dist"],
      ["db", "node_modules/@shop-things/db/dist"],
      ["contract", "node_modules/@shop-things/contract/dist"],
    ] as const) {
      const emitted = join(projectRoot, "packages", folder, "dist");
      for (const path of await filesUnder(emitted)) {
        // electron-builder omits declaration-only files from runtime dependencies.
        if (path.endsWith(".d.ts")) {
          continue;
        }

        if (folder === "electron" && relative(emitted, path).startsWith("renderer/")) {
          continue;
        }

        inventoryFiles.push({
          path: join(destination, relative(emitted, path)),
          sha256: await digest(path),
        });
      }
    }

    const inventoryPath = reportPath + ".inventory.json";
    await writeFile(
      inventoryPath,
      JSON.stringify({ commit: report.commit, files: inventoryFiles }, null, 2) + "\n",
    );
    const runtimeReport = reportPath + ".runtime.json";
    const result = spawnSync(
      executable,
      ["--experimental-strip-types", runtimeScript, resources, runtimeReport, inventoryPath],
      {
        encoding: "utf8",
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    await writeFile(reportPath + ".stdout.log", result.stdout ?? "");
    await writeFile(reportPath + ".stderr.log", result.stderr ?? "");
    report.process = {
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    };
    try {
      report.runtime = JSON.parse(await readFile(runtimeReport, "utf8"));
    } catch (error) {
      report.runtimeReportError = String(error);
    }

    assert.equal(
      result.status,
      0,
      `Shipped backend proof failed:\n${result.stdout}\n${result.stderr}`,
    );
    assert.ok(
      typeof report.runtime === "object" &&
        report.runtime !== null &&
        "status" in report.runtime &&
        report.runtime.status === "passed",
      "Successful shipped runtime report required",
    );
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }

  if (failure) {
    throw failure;
  }
}, 120_000);
