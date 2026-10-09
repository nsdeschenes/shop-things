import assert from 'node:assert/strict';

import {validateReleaseVersion} from './releaseVersion.ts';
import {runIfMain} from './workspace.ts';

const commitPattern = /^[0-9a-f]{40}$/;

export async function verifyReleaseTag(
  version: string,
  commit: string,
  token: string,
  request: typeof fetch = fetch
) {
  validateReleaseVersion(version);
  assert.match(commit, commitPattern);
  let path = `git/ref/tags/v${version}`;
  for (let depth = 0; depth < 5; depth++) {
    const response = await request(
      'https://api.github.com/repos/nsdeschenes/shop-things/' + path,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      }
    );
    if (depth === 0 && response.status === 404) {
      return;
    }

    assert.equal(response.status, 200, 'The release tag identity could not be verified');
    const text = await response.text();
    assert.ok(text.length <= 1048576);
    const value = JSON.parse(text);
    assert.ok(value.object && commitPattern.test(value.object.sha));
    if (value.object.type === 'commit') {
      assert.equal(
        value.object.sha,
        commit,
        'An existing tag must identify the tested release commit'
      );
      return;
    }

    assert.equal(value.object.type, 'tag');
    path = 'git/tags/' + value.object.sha;
  }

  throw new Error('Release tag indirection exceeded its limit');
}

await runIfMain(import.meta.url, async () => {
  assert.ok(process.env.VERSION && process.env.RELEASE_SHA && process.env.GH_TOKEN);
  await verifyReleaseTag(
    process.env.VERSION,
    process.env.RELEASE_SHA,
    process.env.GH_TOKEN
  );
});
