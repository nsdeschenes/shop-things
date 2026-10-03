import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, stat, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import {assert, expect, test} from 'vitest';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const release = join(projectRoot, 'release');
const runtimeScript = fileURLToPath(
  new URL('../scripts/smokePackaged.ts', import.meta.url)
);
const debArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
const bundle = join(
  release,
  process.arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked'
);
async function digest(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function filesUnder(folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, {withFileTypes: true})) {
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
  const result = spawnSync('git', args, {cwd: projectRoot, encoding: 'utf8'});
  expect(result.status, `${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

test(`proves the shipped Linux glibc ${process.arch} backend and retains commit/artifact evidence`, async () => {
  const reportPath = process.env.SMOKE_REPORT_PATH ?? join(release, 'package-smoke.json');
  await mkdir(dirname(reportPath), {recursive: true});
  const report: Record<string, unknown> = {
    schemaVersion: 2,
    status: 'running',
    startedAt: new Date().toISOString(),
    executionEnvironment:
      process.env.SMOKE_EXECUTION_ENVIRONMENT ?? `native Linux glibc ${process.arch}`,
    target: `linux-${process.arch}-glibc`,
  };
  let failure: unknown;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  try {
    report.commit = git(['rev-parse', 'HEAD']);
    report.dirtyCheckout = git(['status', '--porcelain', '--untracked-files=all']) !== '';
    expect(
      report.dirtyCheckout,
      'Acceptance requires clean committed sources, including nonignored untracked files'
    ).toBe(false);
    expect(process.platform).toBe('linux');
    expect(['x64', 'arm64']).toContain(process.arch);
    const diagnostic = process.report.getReport();
    const header =
      typeof diagnostic === 'object' && diagnostic !== null && 'header' in diagnostic
        ? diagnostic.header
        : undefined;
    assert.isOk(
      typeof header === 'object' &&
        header !== null &&
        'glibcVersionRuntime' in header &&
        header.glibcVersionRuntime,
      'Linux acceptance requires glibc'
    );
    report.glibcVersion = header.glibcVersionRuntime;
    const executable = join(bundle, 'shop-things');
    const resources = join(bundle, 'resources');
    const archive = join(resources, 'app.asar');
    const addon = join(
      resources,
      `app.asar.unpacked/node_modules/@tursodatabase/database-linux-${process.arch}-gnu/turso.linux-${process.arch}-gnu.node`
    );
    for (const path of [executable, archive, addon]) {
      expect(
        (await stat(path)).isFile(),
        `Missing packaged resource: ${path}`
      ).toBeTruthy();
    }

    const installers = (await readdir(release)).filter(name =>
      name.endsWith(`_${debArchitecture}.deb`)
    );
    expect(installers.length, `Expected one Linux ${process.arch} installer`).toBe(1);
    const installer = join(release, installers[0]!);
    report.artifacts = await Promise.all(
      [executable, archive, addon, installer].map(async path => ({
        path: relative(release, path),
        sha256: await digest(path),
      }))
    );
    const sourceMigrations = join(projectRoot, 'packages/db/migrations');
    const packagedMigrations = join(resources, 'migrations');
    const sourceFiles = await filesUnder(sourceMigrations);
    const shippedFiles = await filesUnder(packagedMigrations);
    expect(shippedFiles.map(path => relative(packagedMigrations, path))).toStrictEqual(
      sourceFiles.map(path => relative(sourceMigrations, path))
    );
    report.migrations = await Promise.all(
      sourceFiles.map(async path => {
        const shipped = join(packagedMigrations, relative(sourceMigrations, path));
        expect(await readFile(shipped)).toStrictEqual(await readFile(path));
        return {
          path: relative(packagedMigrations, shipped),
          sha256: await digest(shipped),
        };
      })
    );
    const inventoryFiles: {path: string; sha256: string}[] = [];
    for (const [folder, destination] of [
      ['electron', 'dist'],
      ['db', 'node_modules/@shop-things/db/dist'],
      ['contract', 'node_modules/@shop-things/contract/dist'],
    ] as const) {
      const emitted = join(projectRoot, 'packages', folder, 'dist');
      for (const path of await filesUnder(emitted)) {
        // electron-builder omits declaration-only files from runtime dependencies.
        if (path.endsWith('.d.ts')) {
          continue;
        }

        if (folder === 'electron' && relative(emitted, path).startsWith('renderer/')) {
          continue;
        }

        inventoryFiles.push({
          path: join(destination, relative(emitted, path)),
          sha256: await digest(path),
        });
      }
    }

    const inventoryPath = reportPath + '.inventory.json';
    await writeFile(
      inventoryPath,
      JSON.stringify({commit: report.commit, files: inventoryFiles}, null, 2) + '\n'
    );
    const runtimeReport = reportPath + '.runtime.json';
    const result = spawnSync(
      executable,
      [
        '--experimental-strip-types',
        runtimeScript,
        resources,
        runtimeReport,
        inventoryPath,
      ],
      {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
      }
    );
    await writeFile(reportPath + '.stdout.log', result.stdout ?? '');
    await writeFile(reportPath + '.stderr.log', result.stderr ?? '');
    report.process = {
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    };
    try {
      report.runtime = JSON.parse(await readFile(runtimeReport, 'utf8'));
    } catch (error) {
      report.runtimeReportError = String(error);
    }

    expect(
      result.status,
      `Shipped backend proof failed:\n${result.stdout}\n${result.stderr}`
    ).toBe(0);
    expect(
      typeof report.runtime === 'object' &&
        report.runtime !== null &&
        'status' in report.runtime &&
        report.runtime.status === 'passed',
      'Successful shipped runtime report required'
    ).toBeTruthy();
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error =
      error instanceof Error
        ? {message: error.message, stack: error.stack}
        : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  if (failure) {
    throw failure;
  }
}, 120_000);
