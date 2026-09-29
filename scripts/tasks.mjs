/* oxlint-disable import/no-named-export -- Build tasks are also consumed by the development supervisor. */
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./processes.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronRoot = join(root, "packages/electron");
const requireElectron = createRequire(join(electronRoot, "package.json"));
const pnpmScript = process.env.npm_execpath;
const javascriptExtension = /\.[cm]?js$/;
const configurationFile = /^(?:tsconfig.*\.json|vite\.config\.ts)$/;
const typescriptExtension = /\.ts$/;
const prohibitedDependency = /(?:^|\/)(?:electron|drizzle-orm|@tursodatabase|db)(?:\/|$)/;
export function pnpm(args, options = {}) {
  return pnpmScript && javascriptExtension.test(pnpmScript)
    ? runCommand(process.execPath, [pnpmScript, ...args], { cwd: root, ...options })
    : runCommand("pnpm", args, { cwd: root, ...options });
}

async function paths(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await paths(path)));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }

  return output;
}

export async function sourceVersion() {
  const files = [
    join(root, "package.json"),
    join(root, "pnpm-lock.yaml"),
    join(root, "pnpm-workspace.yaml"),
    join(root, "tsconfig.json"),
    ...(await paths(join(root, "scripts"))),
  ];
  for (const name of ["contract", "db", "electron", "interface"]) {
    const packageRoot = join(root, "packages", name);
    files.push(
      ...(await paths(join(packageRoot, "src"))),
      ...(await paths(join(packageRoot, "test"))),
      ...(await paths(join(packageRoot, "scripts"))),
      ...(await paths(join(packageRoot, "migrations"))),
      join(packageRoot, "package.json"),
    );
    for (const entry of await readdir(packageRoot)) {
      if (configurationFile.test(entry)) {
        files.push(join(packageRoot, entry));
      }
    }
  }

  for (const packageRoot of [
    root,
    ...["contract", "db", "electron", "interface"].map((name) => join(root, "packages", name)),
  ]) {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const requirePackage = createRequire(join(packageRoot, "package.json"));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (dependency.startsWith("@shop-things/")) {
        continue;
      }

      let dependencyManifest = null;
      for (const directory of requirePackage.resolve.paths(dependency) ?? []) {
        const candidate = join(directory, dependency, "package.json");
        try {
          await readFile(candidate);
          dependencyManifest = await realpath(candidate);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }

      if (dependencyManifest === null) {
        throw new Error(`Cannot resolve dependency manifest: ${dependency}`);
      }

      files.push(dependencyManifest);
    }
  }

  const hash = createHash("sha256");
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(relative(root, path));
    hash.update(await readFile(path));
  }

  return hash.digest("hex");
}

export async function prepare() {
  await pnpm(["--filter", "@shop-things/contract", "build"]);
  await pnpm(["--filter", "@shop-things/db", "build"]);
  await fresh();
}

async function fresh() {
  await runCommand(process.execPath, ["packages/contract/scripts/freshness.mjs"], { cwd: root });
}

async function compileElectron() {
  await rm(join(electronRoot, "dist"), { recursive: true, force: true });
  await fresh();
  await pnpm([
    "--filter",
    "electron",
    "exec",
    "tsc",
    "--noEmit",
    "false",
    "--allowImportingTsExtensions",
    "false",
    "--rootDir",
    "src",
    "--outDir",
    "dist",
    "--incremental",
    "false",
  ]);
  await runCommand(process.execPath, ["scripts/build-preload.mjs"], { cwd: electronRoot });
}

async function compileInterface(build) {
  await fresh();
  await pnpm(["--filter", "@shop-things/interface", "exec", "tsc", "-b", "--force"]);
  await pnpm(["--filter", "@shop-things/interface", "exec", "tsc", "-p", "tsconfig.contract.json"]);
  if (build) {
    await pnpm(["--filter", "@shop-things/interface", "exec", "vite", "build"]);
  }
}

async function artifactHashes() {
  const artifacts = {};
  const expected = (await paths(join(electronRoot, "src")))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
    .map((path) => relative(join(electronRoot, "src"), path).replace(typescriptExtension, ".js"));
  expected.push("preload.cjs", "preload.meta.json");
  for (const path of expected.sort((left, right) => left.localeCompare(right))) {
    artifacts[path] = createHash("sha256")
      .update(await readFile(join(electronRoot, "dist", path)))
      .digest("hex");
  }

  for (const source of (await paths(join(root, "packages/db/src"))).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!source.endsWith(".ts")) {
      continue;
    }

    const base = relative(join(root, "packages/db/src"), source).slice(0, -3);
    for (const extension of [".js", ".d.ts"]) {
      const name = `db/${base}${extension}`;
      artifacts[name] = createHash("sha256")
        .update(await readFile(join(root, "packages/db/dist", base + extension)))
        .digest("hex");
    }
  }

  return artifacts;
}

async function finishBuild(version) {
  await fresh();
  if ((await sourceVersion()) !== version) {
    throw new Error("Build inputs changed during emission. Rebuild before consuming output.");
  }

  await writeFile(
    join(electronRoot, "dist/build.json"),
    JSON.stringify({ source: version, artifacts: await artifactHashes() }, null, 2),
  );
}

export async function checkElectronOutput() {
  await fresh();
  const marker = JSON.parse(await readFile(join(electronRoot, "dist/build.json"), "utf8"));
  if (
    marker.source !== (await sourceVersion()) ||
    JSON.stringify(marker.artifacts) !== JSON.stringify(await artifactHashes())
  ) {
    throw new Error("Electron output is stale or incomplete. Rebuild before starting.");
  }
}

export async function buildAll({ interfaceBuild = true } = {}) {
  const version = await sourceVersion();
  await prepare();
  await compileElectron();
  await compileInterface(interfaceBuild);
  await inspectBrowserDependencies();
  await finishBuild(version);
}

export async function inspectBrowserDependencies() {
  const { build } = await import(requireElectron.resolve("esbuild"));
  const prohibited = prohibitedDependency;
  const manifest = JSON.parse(await readFile(join(root, "packages/contract/package.json"), "utf8"));
  const visited = new Set();
  async function inspectManifest(path) {
    if (visited.has(path)) {
      return;
    }

    visited.add(path);
    const read = createRequire(path);
    const value = JSON.parse(await readFile(path, "utf8"));
    for (const dependency of Object.keys(value.dependencies ?? {})) {
      if (
        prohibited.test(dependency) ||
        builtinModules.includes(dependency) ||
        dependency.startsWith("node:")
      ) {
        throw new Error(`Prohibited contract dependency: ${dependency}`);
      }

      await inspectManifest(read.resolve(`${dependency}/package.json`));
    }
  }

  await inspectManifest(join(root, "packages/contract/package.json"));
  if (
    Object.values(manifest.exports).some((entry) =>
      Object.values(entry).some((path) => !path.startsWith("./dist/")),
    )
  ) {
    throw new Error("Contract exports must resolve compiled artifacts");
  }

  const bundled = await build({
    entryPoints: [
      join(root, "packages/contract/dist/client.js"),
      join(root, "packages/contract/dist/schemas.js"),
    ],
    bundle: true,
    write: false,
    outdir: "contract-inspection",
    platform: "browser",
    metafile: true,
  });
  if (Object.keys(bundled.metafile.inputs).some((path) => prohibited.test(path))) {
    throw new Error("Backend dependency entered the browser contract");
  }

  if (Object.values(bundled.metafile.outputs).some((output) => output.imports.length !== 0)) {
    throw new Error("Contract bundle contains unresolved runtime imports");
  }

  const preload = JSON.parse(await readFile(join(electronRoot, "dist/preload.meta.json"), "utf8"));
  if (
    Object.values(preload.outputs).some((output) =>
      output.imports.some((entry) => !entry.external || entry.path !== "electron"),
    )
  ) {
    throw new Error("Preload bundle has an unexpected runtime import");
  }
}

function testReportArguments(name) {
  const directory = process.env.ACCEPTANCE_REPORT_DIR;
  return directory
    ? ["--reporter=default", "--reporter=json", `--outputFile=${join(directory, name + ".json")}`]
    : [];
}

async function testElectron(smoke = false, watch = false) {
  await checkElectronOutput();
  await pnpm(["--filter", "electron", "exec", "tsc", "-p", "tsconfig.test.json"]);
  await pnpm(["--filter", "electron", "exec", "tsc", "-p", "tsconfig.contract.json"]);
  await pnpm([
    "--filter",
    "electron",
    "exec",
    "vitest",
    ...(watch ? [] : ["run"]),
    ...(smoke ? ["--config", "vitest.smoke.config.ts"] : []),
    ...testReportArguments(smoke ? "smoke-tests" : "electron-tests"),
  ]);
}

async function testInterface(watch = false) {
  await pnpm([
    "--filter",
    "@shop-things/interface",
    "exec",
    "vitest",
    ...(watch ? [] : ["run"]),
    ...testReportArguments("interface-tests"),
  ]);
}

export async function task(name) {
  switch (name) {
    case "prepare":
      return prepare();
    case "build":
      return buildAll();
    case "electron-build":
      return buildAll({ interfaceBuild: false });
    case "preload-build":
      await prepare();
      return runCommand(process.execPath, ["scripts/build-preload.mjs"], { cwd: electronRoot });
    case "interface-dev":
      await prepare();
      await compileInterface(false);
      return pnpm(["--filter", "@shop-things/interface", "exec", "vite"]);
    case "interface-build":
      await prepare();
      return compileInterface(true);
    case "interface-test":
      await prepare();
      await compileInterface(false);
      return testInterface();
    case "electron-test":
      await buildAll({ interfaceBuild: false });
      return testElectron();
    case "electron-smoke":
      await buildAll();
      return testElectron(true);
    case "test":
      // Mutation/freshness tests must finish before dependent consumers compile or run.
      await pnpm(["--filter", "@shop-things/contract", "test"]);
      if (process.env.ACCEPTANCE_REPORT_DIR) {
        await pnpm(["--filter", "@shop-things/db", "build"]);
        await pnpm(["--filter", "@shop-things/db", "exec", "tsc", "-p", "tsconfig.test.json"]);
        await pnpm([
          "--filter",
          "@shop-things/db",
          "exec",
          "vitest",
          "run",
          ...testReportArguments("db-tests"),
        ]);
      } else {
        await pnpm(["--filter", "@shop-things/db", "test"]);
      }

      await pnpm(["--filter", "@shop-things/db", "migrations:check"]);
      await buildAll({ interfaceBuild: false });
      await testElectron();
      await testInterface();
      return runCommand(
        process.execPath,
        [
          "--test",
          "--test-concurrency=1",
          "scripts/test/processes.test.mjs",
          "scripts/test/build.test.mjs",
        ],
        { cwd: root },
      );
    case "electron-watch":
    case "interface-watch":
      return task("test-watch");
    case "test-watch": {
      const { watchTests } = await import("./development.mjs");
      return watchTests();
    }

    case "start":
      await buildAll();
      await checkElectronOutput();
      return runCommand(requireElectron("electron"), ["."], { cwd: electronRoot });
    case "dev": {
      const { develop } = await import("./development.mjs");
      return develop();
    }

    default:
      throw new Error(`Unknown task: ${name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await task(process.argv[2]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
