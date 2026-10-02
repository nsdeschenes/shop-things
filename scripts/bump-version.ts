import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';

import {readReleaseManifests, validateReleaseVersion} from './releaseVersion.ts';

const version = process.env.CRAFT_NEW_VERSION;
assert.ok(version, 'Craft must provide CRAFT_NEW_VERSION');
validateReleaseVersion(version);
for (const {path, contents} of readReleaseManifests()) {
  contents.version = version;
  writeFileSync(path, JSON.stringify(contents, null, 2) + '\n');
}
