import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {
  createDebianFixture,
  createReleaseFixture,
  runReleaseScript,
  releaseAcceptance,
} from './releaseHelpers.ts';

test('stages only the accepted arm64 installer and generates its verifiable checksum', async () => {
  const directory = await createReleaseFixture();
  const commit = 'a'.repeat(40);
  let payload: Buffer;
  try {
    await mkdir(join(directory, 'release'));
    await mkdir(join(directory, 'reports'));
    const installer = await createDebianFixture(directory, {
      filename: 'electron_0.0.1_arm64.deb',
    });
    payload = await readFile(installer);
    await writeFile(join(directory, 'release/ignored.yml'), 'packaging metadata');
    const reportPath = join(directory, 'reports/acceptance.json');
    const report = await releaseAcceptance(commit, installer);
    await writeFile(reportPath, JSON.stringify(report));
    const env = {GITHUB_SHA: commit, ACCEPTANCE_REPORT_DIR: join(directory, 'reports')};
    const result = runReleaseScript(directory, 'stage-release', env);
    expect(result).toMatchObject({status: 0});
    const filename = 'shop-things-0.0.1-linux-arm64.deb';
    expect(await readdir(join(directory, 'release/assets'))).toStrictEqual([
      'SHA256SUMS',
      filename,
      'shop-things-update-v1.json',
    ]);
    expect(await readFile(join(directory, 'release/assets', filename))).toStrictEqual(
      payload
    );
    expect(await readFile(join(directory, 'release/assets/SHA256SUMS'), 'utf8')).toBe(
      `${createHash('sha256').update(payload).digest('hex')}  ${filename}\n`
    );
    for (const invalidReport of [
      {...report, status: 'failed'},
      {...report, commit: 'b'.repeat(40)},
      {...report, environment: {target: 'darwin-arm64-supporting-unsigned'}},
      {...report, environment: {target: 'linux-x64-glibc'}},
    ]) {
      await writeFile(reportPath, JSON.stringify(invalidReport));
      expect(runReleaseScript(directory, 'stage-release', env).status).toBe(1);
    }

    await writeFile(reportPath, JSON.stringify(report));
    await writeFile(join(directory, 'release/extra_0.0.1_amd64.deb'), payload);
    expect(runReleaseScript(directory, 'stage-release', env).stderr).toContain(
      'Expected exactly one Debian installer'
    );
    await rm(join(directory, 'release/electron_0.0.1_arm64.deb'));
    expect(runReleaseScript(directory, 'stage-release', env).stderr).toContain(
      'Expected this version and arm64 architecture'
    );
    await rm(join(directory, 'release/extra_0.0.1_amd64.deb'));
    expect(runReleaseScript(directory, 'stage-release', env).status).toBe(1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
