import assert from 'node:assert/strict';

import {checkReleaseVersions} from './releaseVersion.ts';

assert.ok(process.env.VERSION, 'Provide the prepared VERSION');
checkReleaseVersions(process.env.VERSION);
