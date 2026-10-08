import {execFileSync} from 'node:child_process';

import {expect, test} from 'vitest';

import {compareDebianVersions} from '../src/updateVersions.js';

// Known Debian ordering cases, cross-checked against the real dpkg implementation.
test.each([
  ['1:0.1', '0.9', 1],
  ['1.0~rc1', '1.0', -1],
  ['1.0', '1.0-0', 0],
  ['1.0-2', '1.0-10', -1],
  ['1.0+build', '1.0', 1],
  ['1.0a', '1.0+', -1],
  ['1.0~~', '1.0~', -1],
  ['1.01', '1.1', 0],
  ['1.0-1+b1', '1.0-1', 1],
  ['1.0-alpha-2', '1.0-alpha-10', -1],
])('compares %s and %s independently of app SemVer', async (left, right, expected) => {
  expect(await compareDebianVersions(left, right)).toBe(expected);
  const operation = expected > 0 ? 'gt' : expected < 0 ? 'lt' : 'eq';
  expect(() =>
    execFileSync('/usr/bin/dpkg', ['--compare-versions', left, operation, right])
  ).not.toThrow();
});
