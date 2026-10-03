import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {checkReleaseVersions} from './releaseVersion.ts';

const version = checkReleaseVersions();
const reportDirectory = process.env.ACCEPTANCE_REPORT_DIR;
const commit = process.env.GITHUB_SHA;
assert.ok(reportDirectory && commit, 'Provide ACCEPTANCE_REPORT_DIR and GITHUB_SHA');
const report = JSON.parse(readFileSync(join(reportDirectory, 'acceptance.json'), 'utf8'));
assert.equal(report.status, 'passed', 'Acceptance must pass before staging a release');
assert.equal(report.commit, commit, 'Acceptance must test the release commit');
assert.equal(report.environment.target, 'linux-arm64-glibc');
const installers = readdirSync('release').filter(name => name.endsWith('.deb'));
assert.equal(installers.length, 1, 'Expected exactly one Debian installer');
const installer = installers[0]!;
assert.ok(
  installer.endsWith(`_${version}_arm64.deb`),
  'Expected this version and arm64 architecture'
);
const filename = `shop-things-${version}-linux-arm64.deb`;
const installerPath = join('release', installer);
const checksum = createHash('sha256').update(readFileSync(installerPath)).digest('hex');
const outputDirectory = join('release', 'assets');
rmSync(outputDirectory, {recursive: true, force: true});
mkdirSync(outputDirectory, {recursive: true});
copyFileSync(installerPath, join(outputDirectory, filename));
writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
