// Executable boundary fixture; the real acceptance runner validates these artifacts.
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';

const directory = process.env.ACCEPTANCE_REPORT_DIR;
const args = process.argv.slice(2);
const name = basename(process.argv[1]);
async function json(path, value) {
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, JSON.stringify(value));
}

console.log('fixture command:', name, ...args);
if (args[0] === process.env.FIXTURE_FAIL_COMMAND) {
  console.error('fixture child diagnostic');
  process.exit(23);
}

if (args[0] === '--version') {
  console.log('12.4.2');
}

if (args[0] === 'test') {
  for (const suite of ['contract', 'db', 'electron', 'interface', 'scripts']) {
    await json(join(directory, suite + '-tests.json'), {
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numPendingTests: 0,
      numFailedTests: 0,
    });
  }
}

if (args[0] === 'test:renderer') {
  await json('acceptance-reports/renderer/results.json', {
    stats: {expected: 1, unexpected: 0, skipped: 0, flaky: 0},
  });
}

const reportName =
  name === 'packagedRenderer.mjs'
    ? 'packaged-renderer.json'
    : name === 'watcher.mjs'
      ? 'watcher.json'
      : args.includes('test:smoke')
        ? 'package-smoke.json'
        : null;
if (reportName) {
  await json(join(directory, reportName), {
    status: 'passed',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  });
}
