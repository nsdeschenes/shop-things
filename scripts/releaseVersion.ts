/* oxlint-disable import/no-named-export -- Shared release version helpers. */
import assert from 'node:assert/strict';
import {globSync, readFileSync} from 'node:fs';

type ReleaseManifest = {path: string; contents: {version: string}};
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function readReleaseManifests(): ReleaseManifest[] {
  const paths = ['package.json', ...globSync('packages/*/package.json').sort()];
  return paths.map(path => ({
    path,
    contents: JSON.parse(readFileSync(path, 'utf8')) as {version: string},
  }));
}

export function validateReleaseVersion(version: string): void {
  assert.match(version, stableVersion, 'A stable version without a v prefix is required');
}

export function checkReleaseVersions(expectedVersion?: string): string {
  const manifests = readReleaseManifests();
  const version = expectedVersion ?? manifests[0]!.contents.version;
  validateReleaseVersion(version);
  for (const {path, contents} of manifests) {
    assert.equal(contents.version, version, `${path} must use ${version}`);
  }

  return version;
}
