// Linux package acceptance: keep machine reports and logs even when prerequisites fail.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const directory = resolve(process.env.ACCEPTANCE_REPORT_DIR ?? "acceptance-reports");
await mkdir(directory, { recursive: true });
const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const report = {
  schemaVersion: 1,
  status: "running",
  commit: git(["rev-parse", "HEAD"]),
  startedAt: new Date().toISOString(),
  environment: process.env.SMOKE_EXECUTION_ENVIRONMENT ?? "native-linux-x64-glibc",
  steps: [],
};
const reportPath = join(directory, "acceptance.json");
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
await persist();
async function command(name, args) {
  const step = {
    name,
    status: "running",
    startedAt: new Date().toISOString(),
    command: ["pnpm", ...args],
  };
  report.steps.push(step);
  await persist();
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("pnpm", args, {
        env: {
          ...process.env,
          ACCEPTANCE_REPORT_DIR: directory,
          SMOKE_REPORT_PATH: join(directory, "package-smoke.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
        process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        step.exitCode = code;
        step.signal = signal;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${name} failed: ${signal ?? code}`));
        }
      });
    });
    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    step.error = String(error);
    throw error;
  } finally {
    step.finishedAt = new Date().toISOString();
    await writeFile(join(directory, name + ".log"), output);
    await persist();
  }

  return output;
}

try {
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=all"]),
    "",
    "Require clean committed sources",
  );
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  await command("install", ["install", "--frozen-lockfile"]);
  const testLog = await command("tests", ["test"]);
  for (const suite of ["db", "electron", "interface"]) {
    const results = JSON.parse(await readFile(join(directory, suite + "-tests.json"), "utf8"));
    assert.equal(results.success, true);
    assert.ok(results.numTotalTests > 0);
    assert.equal(results.numPendingTests, 0);
    assert.equal(results.numTodoTests ?? 0, 0);
    assert.equal(results.numFailedTests, 0);
    assert.equal(
      results.numPassedTests,
      results.numTotalTests,
      `No skipped ${suite} checks permitted`,
    );
  }

  const tapSkipCounts = Array.from(testLog.matchAll(/# skipped (\d+)/g), (match) =>
    Number(match[1]),
  );
  assert.ok(tapSkipCounts.length >= 2, "Contract and Node build/process TAP results required");
  assert.ok(tapSkipCounts.every((count) => count === 0));
  assert.equal(/# (?:cancelled|todo) [1-9]/.test(testLog), false);
  await command("build", ["build"]);
  await command("lint", ["lint"]);
  await command("package", [
    "--filter",
    "electron",
    "exec",
    "electron-builder",
    "--linux",
    "deb",
    "--x64",
    "--publish",
    "never",
  ]);
  await command("shipped-backend", ["--filter", "electron", "test:smoke"]);
  const smoke = JSON.parse(await readFile(join(directory, "package-smoke.json"), "utf8"));
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.commit, report.commit);
  assert.ok(smoke.artifacts.length >= 4);
  assert.ok(smoke.runtime.buildInventory.files.length > 10);
  report.package = smoke;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error =
    error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
}
