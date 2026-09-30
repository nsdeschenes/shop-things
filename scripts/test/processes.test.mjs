/* oxlint-disable vitest-js/no-import-node-test -- These checks exercise native child processes with Node's runner. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { requestOrderlyExit, RestartSupervisor, runCommand } from "../processes.mjs";

async function childProcess(mode) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.on('message', message => {
      if(message.type === 'shop-things:quit') {
        if(${JSON.stringify(mode)} === 'deny') process.send({denied:true});
        else setTimeout(() => {process.send({closed:true});process.disconnect();},40);
      }
      if(message.type === 'finish-test') process.disconnect();
    });
    process.send({ready:true});
  `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  await once(child, "message");
  return child;
}

test("orderly restart waits for a real child to close", async () => {
  const accepted = await childProcess("accept");
  assert.equal(await requestOrderlyExit(accepted, 1000), true);
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.killed, false);
});

test("failed builds prevent launches until a successful cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-things-build-gate-"));
  const versionPath = join(directory, "version");
  const launchPath = join(directory, "launched");
  await writeFile(versionPath, "1");
  let failing = true;
  const failures = [];
  const supervisor = new RestartSupervisor({
    version: () => readFile(versionPath, "utf8"),
    stop: async () => true,
    async build() {
      await runCommand(process.execPath, ["-e", failing ? "process.exit(1)" : "process.exit(0)"], {
        stdio: "ignore",
      });
    },
    start: () =>
      runCommand(
        process.execPath,
        ["-e", "require('node:fs').appendFileSync(process.argv[1],'launched\\n')", launchPath],
        { stdio: "ignore" },
      ),
    report: (error) => failures.push(error),
  });
  try {
    await supervisor.refresh();
    await assert.rejects(readFile(launchPath), { code: "ENOENT" });
    assert.equal(failures.length, 1);
    failing = false;
    await writeFile(versionPath, "2");
    await supervisor.refresh();
    assert.equal(await readFile(launchPath, "utf8"), "launched\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("edits during a real build reject obsolete output and serialize concurrent refreshes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-things-build-change-"));
  const source = join(directory, "source");
  await writeFile(source, "first");
  let builds = 0,
    launches = 0;
  const supervisor = new RestartSupervisor({
    version: () => readFile(source, "utf8"),
    stop: async () => true,
    async build() {
      builds++;
      await runCommand(
        process.execPath,
        [
          "-e",
          builds === 1
            ? "require('node:fs').writeFileSync(process.argv[1],'second')"
            : "process.exit(0)",
          source,
        ],
        { stdio: "ignore" },
      );
    },
    start: async () => {
      launches++;
    },
  });
  try {
    await Promise.all([supervisor.refresh(), supervisor.refresh(), supervisor.refresh()]);
    assert.equal(builds, 2);
    assert.equal(launches, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a denied real application shutdown prevents destructive rebuild or replacement launch", async () => {
  const child = await childProcess("deny");
  let builds = 0,
    launches = 0;
  const supervisor = new RestartSupervisor({
    version: async () => "changed",
    stop: () => requestOrderlyExit(child, 40),
    build: async () => {
      builds++;
    },
    start: async () => {
      launches++;
    },
    report: () => {},
  });
  try {
    await supervisor.refresh();
    assert.equal(builds, 0);
    assert.equal(launches, 0);
    assert.equal(child.exitCode, null);
    assert.equal(child.killed, false);
    assert.equal(child.killed, false);
  } finally {
    child.send({ type: "finish-test" });
    await once(child, "exit");
  }
});
