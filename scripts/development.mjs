/* oxlint-disable import/no-named-export -- Development entrypoints are dispatched by the shared task runner. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildAll, root, sourceVersion, task } from "./tasks.mjs";
import { requestOrderlyExit, RestartSupervisor } from "./processes.mjs";

export async function develop() {
  const requireElectron = createRequire(join(root, "packages/electron/package.json"));
  let electron = null;
  let vite = null;
  let stopping = false;
  let timer = null;
  const url = "http://127.0.0.1:5173";
  const supervisor = new RestartSupervisor({
    version: sourceVersion,
    stop: async () => !stopping && (electron === null || (await requestOrderlyExit(electron))),
    build: () => buildAll(),
    start: async () => {
      if (stopping) {
        return;
      }

      if (vite === null) {
        const requireInterface = createRequire(join(root, "packages/interface/package.json"));
        vite = spawn(
          process.execPath,
          [join(dirname(requireInterface.resolve("vite/package.json")), "bin/vite.js")],
          {
            cwd: join(root, "packages/interface"),
            detached: true,
            stdio: ["inherit", "inherit", "inherit", "ipc"],
          },
        );
        vite.on("error", console.error);
      }

      const deadline = Date.now() + 15_000;
      while (true) {
        if (vite.exitCode !== null || Date.now() > deadline) {
          throw new Error("The development renderer did not become available");
        }

        try {
          if ((await fetch(url)).ok) {
            break;
          }
        } catch {
          /* Vite may still be starting. */
        }

        await delay(100);
      }

      electron = spawn(requireElectron("electron"), ["."], {
        cwd: join(root, "packages/electron"),
        detached: true,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { ...process.env, VITE_DEV_SERVER_URL: url },
      });
      electron.on("error", console.error);
    },
  });
  async function shutdown() {
    if (stopping) {
      return;
    }

    stopping = true;
    clearInterval(timer);
    if (electron && !(await requestOrderlyExit(electron))) {
      console.error("The application remains open. Close it to finish development.");
      electron.once("exit", () => {
        vite?.kill("SIGTERM");
      });
      return;
    }

    // Vite holds no customer drafts; Electron always closes through parent IPC.
    vite?.kill("SIGTERM");
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  try {
    await supervisor.refresh();
  } catch (error) {
    await shutdown();
    throw error;
  }

  if (!stopping) {
    timer = setInterval(() => {
      void supervisor.refresh().catch(console.error);
    }, 500);
  }
}

export async function watchTests() {
  let last = null;
  while (true) {
    const version = await sourceVersion();
    if (version !== last) {
      last = version;
      try {
        await task("test");
      } catch (error) {
        console.error(error);
      }
    }

    await delay(500);
  }
}
