import {generateKeyPairSync, sign} from 'node:crypto';

import {afterEach, assert, expect, test, vi} from 'vitest';

import {UpdateDiscovery} from '../src/updateDiscovery.js';
import {UpdateNetworkError} from '../src/updateNetwork.js';
afterEach(() => vi.useRealTimers());

const keys = generateKeyPairSync('ed25519');
function release(version: string, packageVersion = version) {
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      applicationId: 'com.shopthings.app',
      repository: 'nsdeschenes/shop-things',
      channel: 'stable',
      appVersion: version,
      packageName: 'shop-things',
      packageVersion,
      platform: 'linux',
      architecture: 'arm64',
      helperProtocol: {min: 1, max: 1},
      artifact: {
        filename: `shop-things-${version}-linux-arm64.deb`,
        byteLength: 100,
        sha256: 'a'.repeat(64),
      },
    })
  );
  const base = `https://github.com/nsdeschenes/shop-things/releases/download/v${version}/`;
  const names = [
    'shop-things-update-v1.json',
    'shop-things-update-v1.sig',
    `shop-things-${version}-linux-arm64.deb`,
  ];
  return {
    metadata: {
      draft: false,
      prerelease: false,
      tag_name: `v${version}`,
      assets: names.map(name => ({name, browser_download_url: base + name})),
    },
    manifest,
    signature: sign(null, manifest, keys.privateKey),
  };
}

test('offers the newest signed compatible release without fetching the installer', async () => {
  const releases = [release('0.5.0', '0.2.0'), release('0.4.0'), release('0.3.0')];
  const requested: string[] = [];
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: ['Installation is not available yet.'],
    compareDebian: async (left, right) => left.localeCompare(right),
    request: async url => {
      requested.push(url);
      if (url.startsWith('https://api.github.com/')) {
        return Buffer.from(JSON.stringify(releases.map(value => value.metadata)));
      }

      const item = releases.find(value => url.includes(value.metadata.tag_name));
      if (!item) {
        throw new Error('Unexpected URL');
      }

      return url.endsWith('.json') ? item.manifest : item.signature;
    },
  });
  const outcome = await discovery.check({});
  expect(outcome).toMatchObject({
    status: 'success',
    value: {
      phase: 'available',
      targetVersion: '0.4.0',
      capabilityReasons: ['Installation is not available yet.'],
    },
  });
  expect(requested.some(url => url.endsWith('.deb'))).toBe(false);
  expect(
    await discovery.start({
      candidateId: outcome.status === 'success' ? outcome.value.candidateId! : '',
    })
  ).toMatchObject({status: 'error'});
});

test('coalesces overlapping checks and reports pagination exhaustion instead of current', async () => {
  let finish!: (value: Uint8Array) => void;
  let calls = 0;
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: [],
    request: async () => {
      calls++;
      if (calls === 1) {
        return new Promise(resolve => {
          finish = resolve;
        });
      }

      return Buffer.from(
        JSON.stringify(Array.from({length: 100}, () => ({draft: true})))
      );
    },
  });
  const first = discovery.check({});
  const second = discovery.check({});
  expect(first).toBe(second);
  finish(Buffer.from(JSON.stringify(Array.from({length: 100}, () => ({draft: true})))));
  expect(await first).toMatchObject({
    status: 'success',
    value: {phase: 'check-failed', errorCode: 'DISCOVERY_LIMIT'},
  });
  expect(calls).toBe(10);
});

test('excludes replaced signatures, release tag mismatches and attacker-controlled asset URLs', async () => {
  const items = [release('0.5.0'), release('0.4.0'), release('0.3.2')];
  items[0]!.signature = Buffer.alloc(64);
  items[1]!.metadata.tag_name = 'v0.6.0';
  items[2]!.metadata.assets[0]!.browser_download_url = 'https://evil.example/manifest';
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: [],
    compareDebian: async () => 1,
    request: async url => {
      if (url.startsWith('https://api.github.com/')) {
        return Buffer.from(JSON.stringify(items.map(item => item.metadata)));
      }

      const item = items.find(value => url.includes(value.metadata.tag_name))!;
      return url.endsWith('.json') ? item.manifest : item.signature;
    },
  });
  expect(await discovery.check({})).toMatchObject({
    status: 'success',
    value: {phase: 'current'},
  });
});

test('checks at startup and hourly, stops while closed, and honors release-service backoff', async () => {
  vi.useFakeTimers();
  let calls = 0;
  let limited = false;
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: [],
    request: async () => {
      calls++;
      if (limited) {
        throw new UpdateNetworkError('RATE_LIMIT', Date.now() + 120000);
      }

      return Buffer.from('[]');
    },
  });
  discovery.startChecking();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(calls).toBe(2);
  discovery.stop();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(calls).toBe(2);
  limited = true;
  expect(await discovery.check({})).toMatchObject({
    status: 'success',
    value: {errorCode: 'RATE_LIMIT'},
  });
  await discovery.check({});
  expect(calls).toBe(3);
  await vi.advanceTimersByTimeAsync(120000);
  limited = false;
  expect(await discovery.check({})).toMatchObject({
    status: 'success',
    value: {phase: 'current'},
  });
  expect(calls).toBe(4);
});

test('selects a retained compatible bridge when the newest signed release requires another helper protocol', async () => {
  const newest = release('0.5.0');
  const bridge = release('0.4.0');
  const body = JSON.parse(newest.manifest.toString());
  body.helperProtocol = {min: 2, max: 2};
  newest.manifest = Buffer.from(JSON.stringify(body));
  newest.signature = sign(null, newest.manifest, keys.privateKey);
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: [],
    request: async url => {
      if (url.startsWith('https://api.github.com/')) {
        return Buffer.from(JSON.stringify([newest.metadata, bridge.metadata]));
      }

      const item = url.includes('v0.5.0') ? newest : bridge;
      return url.endsWith('.json') ? item.manifest : item.signature;
    },
  });
  const result = await discovery.check({});
  expect(result).toMatchObject({
    status: 'success',
    value: {phase: 'available', targetVersion: '0.4.0'},
  });
  assert(result.status === 'success');
  expect(discovery.getCandidate(result.value.candidateId!)?.manifest.appVersion).toBe(
    '0.4.0'
  );
  expect(discovery.getCandidate('unknown')).toBeNull();
});

test('recovery retry coalesces an owner-minted read-only evidence check without update admission', async () => {
  let finish!: (value: 'ready' | 'recovery') => void;
  let checks = 0;
  let network = 0;
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: [],
    admissionAllowed: () => false,
    request: async () => {
      network++;
      return Buffer.from('[]');
    },
    recheck: async () => {
      checks++;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  discovery.setPackageRecovery();
  const state = await discovery.getState({});
  assert(state.status === 'success');
  assert(state.value.attemptId);
  expect(state.value.nextActions).toEqual(['retry']);
  expect(await discovery.retry({attemptId: 'stale'})).toMatchObject({status: 'error'});
  expect(checks).toBe(0);
  const first = discovery.retry({attemptId: state.value.attemptId});
  const second = discovery.retry({attemptId: state.value.attemptId});
  expect(checks).toBe(1);
  expect(await discovery.getState({})).toMatchObject({
    status: 'success',
    value: {phase: 'reconciling', nextActions: []},
  });
  finish('recovery');
  expect(await first).toMatchObject({
    status: 'success',
    value: {phase: 'package-recovery', nextActions: ['retry']},
  });
  expect(await second).toEqual(await first);
  const resolved = discovery.retry({attemptId: state.value.attemptId});
  finish('ready');
  expect(await resolved).toMatchObject({
    status: 'success',
    value: {phase: 'idle', nextActions: ['check']},
  });
  expect(network).toBe(0);
});

test('protected unchanged rechecks preserve lock and transaction reasons with explicit Retry', async () => {
  for (const [reason, errorCode] of [
    ['package-lock', 'PACKAGE_LOCK'],
    ['transaction-rejected', 'TRANSACTION_REJECTED'],
  ] as const) {
    const updates = new UpdateDiscovery({
      appVersion: '0.3.1',
      packageVersion: '0.3.1',
      trustedKeys: [],
      capabilityReasons: [],
      recheck: async () => reason,
    });
    updates.setPackageRecovery();
    const state = await updates.getState({});
    if (state.status !== 'success') {
      throw new Error('Could not read the update state');
    }

    const attemptId = state.value.attemptId!;
    expect(await updates.retry({attemptId})).toMatchObject({
      status: 'success',
      value: {attemptId, phase: 'retryable-failure', errorCode, nextActions: ['retry']},
    });
  }
});
