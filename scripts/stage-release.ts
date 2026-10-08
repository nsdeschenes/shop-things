import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {checkReleaseVersions} from './releaseVersion.ts';
import {debianIdentity, validateAcceptance} from './updateRelease.ts';

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
const identity = debianIdentity(installerPath);
const installerBytes = readFileSync(installerPath);
assert.ok(installerBytes.byteLength > 0 && installerBytes.byteLength <= 1073741824);
const checksum = createHash('sha256').update(installerBytes).digest('hex');
validateAcceptance(report, commit, checksum);
const outputDirectory = join('release', 'assets');
rmSync(outputDirectory, {recursive: true, force: true});
mkdirSync(outputDirectory, {recursive: true});
writeFileSync(join(outputDirectory, filename), installerBytes);
writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
writeFileSync(
  join(outputDirectory, 'shop-things-update-v1.json'),
  JSON.stringify({
    schemaVersion: 1,
    applicationId: 'com.shopthings.app',
    repository: 'nsdeschenes/shop-things',
    channel: 'stable',
    appVersion: version,
    packageName: 'shop-things',
    packageVersion: identity.packageVersion,
    platform: 'linux',
    architecture: 'arm64',
    helperProtocol: {min: 1, max: 1},
    artifact: {
      filename,
      byteLength: installerBytes.byteLength,
      sha256: checksum,
    },
  }) + '\n'
);
