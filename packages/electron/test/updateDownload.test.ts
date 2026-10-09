import {execFileSync} from 'node:child_process';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, expect, test, vi} from 'vitest';

import {UpdateDiscovery} from '../src/updateDiscovery.js';
import type {DiscoveredUpdateCandidate} from '../src/updateDiscovery.js';
import {
  downloadUpdateCandidate,
  verifyStagedUpdateArtifact,
} from '../src/updateDownload.js';

const keys = generateKeyPairSync('ed25519');
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(path => rm(path, {recursive: true, force: true}))
  );
});

async function fixture(
  packageName = 'shop-things',
  packageVersion = '0.4.0',
  architecture = 'arm64'
) {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-download-'));
  directories.push(directory);
  const packageRoot = join(directory, 'package');
  await mkdir(join(packageRoot, 'DEBIAN'), {recursive: true});
  await writeFile(
    join(packageRoot, 'DEBIAN/control'),
    `Package: ${packageName}\nVersion: ${packageVersion}\nArchitecture: ${architecture}\nMaintainer: Shop Things\nDescription: Update acceptance fixture\n`
  );
  const path = join(directory, 'fixture.deb');
  execFileSync('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', packageRoot, path]);
  const bytes = await readFile(path);
  const manifest = {
    schemaVersion: 1 as const,
    applicationId: 'com.shopthings.app' as const,
    repository: 'nsdeschenes/shop-things' as const,
    channel: 'stable' as const,
    appVersion: '0.4.0',
    packageName: 'shop-things' as const,
    packageVersion: '0.4.0',
    platform: 'linux' as const,
    architecture: 'arm64' as const,
    helperProtocol: {min: 1 as const, max: 1 as const},
    artifact: {
      filename: 'shop-things-0.4.0-linux-arm64.deb',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const raw = Buffer.from(JSON.stringify(manifest));
  const candidate: DiscoveredUpdateCandidate = {
    id: 'candidate',
    manifest,
    bytes: raw,
    signature: sign(null, raw, keys.privateKey),
    url: 'https://github.com/nsdeschenes/shop-things/releases/download/v0.4.0/shop-things-0.4.0-linux-arm64.deb',
  };
  return {directory: join(directory, 'updates'), bytes, candidate};
}

test('streams a selected signed .deb into private storage and verifies actual package metadata', async () => {
  const f = await fixture();
  const progress: number[] = [];
  const artifact = await downloadUpdateCandidate(
    f.candidate,
    {
      directory: f.directory,
      trustedKeys: [keys.publicKey],
      transport: async () => new Response(f.bytes),
    },
    'attempt',
    {progress: value => progress.push(value), verifying: () => {}},
    new AbortController().signal
  );
  expect(await readFile(artifact.path)).toEqual(f.bytes);
  expect(artifact).toMatchObject({
    attemptId: 'attempt',
    candidateId: 'candidate',
    packageVersion: '0.4.0',
  });
  expect(progress.at(-1)).toBe(1);
});

test('rejects a correctly signed digest whose real Debian identity is different', async () => {
  const f = await fixture('electron');
  const transport = vi.fn(async () => new Response(f.bytes));
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'attempt',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await readdir(join(f.directory, 'attempt'))).toEqual(['record.json']);
  expect(
    JSON.parse(await readFile(join(f.directory, 'attempt', 'record.json'), 'utf8'))
  ).toMatchObject({phase: 'failed', errorCode: 'VERIFICATION'});
});

test('rejects altered and oversized bytes without a verification override or automatic retry', async () => {
  const f = await fixture();
  const changed = Buffer.from(f.bytes);
  changed[changed.length - 1] = changed.at(-1)! ^ 1;
  const transport = vi.fn(async () => new Response(changed));
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'altered',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(transport).toHaveBeenCalledTimes(1);
  transport.mockImplementation(
    async () => new Response(Buffer.concat([f.bytes, Buffer.from('extra')]))
  );
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'oversized',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(await readdir(join(f.directory, 'oversized'))).toEqual(['record.json']);
});

test('restarts interrupted transfers from fresh files at most twice and keeps storage private', async () => {
  const f = await fixture();
  const transport = vi
    .fn(async () => new Response(f.bytes.subarray(0, 20)))
    .mockImplementationOnce(async () => new Response(f.bytes.subarray(0, 10)))
    .mockImplementationOnce(async () => new Response(f.bytes.subarray(0, 15)));
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'interrupted',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'NETWORK'});
  expect(transport).toHaveBeenCalledTimes(3);
  expect(await readdir(join(f.directory, 'interrupted'))).toEqual(['record.json']);
  const artifact = await downloadUpdateCandidate(
    f.candidate,
    {
      directory: f.directory,
      trustedKeys: [keys.publicKey],
      transport: async () => new Response(f.bytes),
    },
    'complete',
    {progress: () => {}, verifying: () => {}},
    new AbortController().signal
  );
  expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
  expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
  await writeFile(artifact.path, 'replacement');
  await expect(
    verifyStagedUpdateArtifact(f.candidate, artifact, [keys.publicKey])
  ).rejects.toMatchObject({code: 'VERIFICATION'});
});

test('explicit opaque intent owns one background attempt and exposes progress through verification', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const discovery = new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: ['Installation is not available yet.'],
    download: {
      directory: f.directory,
      transport: async () => {
        await gate;
        return new Response(f.bytes);
      },
    },
    request: async url => {
      if (url.startsWith('https://api.github.com/')) {
        return Buffer.from(
          JSON.stringify([
            {
              tag_name: 'v0.4.0',
              draft: false,
              prerelease: false,
              assets: [
                'shop-things-update-v1.json',
                'shop-things-update-v1.sig',
                'shop-things-0.4.0-linux-arm64.deb',
              ].map(name => ({
                name,
                browser_download_url: `https://github.com/nsdeschenes/shop-things/releases/download/v0.4.0/${name}`,
              })),
            },
          ])
        );
      }

      return url.endsWith('.json') ? f.candidate.bytes : f.candidate.signature;
    },
  });
  const revisions: number[] = [];
  const phases: string[] = [];
  discovery.onStateChanged(state => {
    revisions.push(state.revision);
    phases.push(state.phase);
  });
  const checked = await discovery.check({});
  expect(checked).toMatchObject({
    status: 'success',
    value: {phase: 'available', nextActions: ['check', 'update']},
  });
  if (checked.status !== 'success') {
    throw new Error('Missing candidate');
  }

  expect(await discovery.start({candidateId: 'stale'})).toMatchObject({
    error: {code: 'VALIDATION'},
  });
  const started = await discovery.start({candidateId: checked.value.candidateId!});
  expect(started).toMatchObject({
    status: 'success',
    value: {phase: 'downloading', attemptId: expect.any(String), progress: 0},
  });
  expect(await discovery.start({candidateId: checked.value.candidateId!})).toMatchObject({
    error: {code: 'BUSY'},
  });
  expect(await discovery.check({})).toMatchObject({
    status: 'success',
    value: {phase: 'downloading'},
  });
  release();
  await vi.waitFor(async () =>
    expect(await discovery.getState({})).toMatchObject({
      status: 'success',
      value: {phase: 'staged', progress: 1},
    })
  );
  expect(phases).toContain('verifying');
  expect(
    revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)
  ).toBe(true);
  if (started.status !== 'success') {
    throw new Error('Missing attempt');
  }

  expect(await discovery.getVerifiedArtifact(started.value.attemptId!)).toMatchObject({
    packageVersion: '0.4.0',
  });
  expect(await discovery.retry({attemptId: started.value.attemptId!})).toMatchObject({
    error: {code: 'VALIDATION'},
  });
});

test('deadline bounds apply to connect, transfer inactivity and total transfer across retries', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    const connected: (() => void)[] = [];
    const connections = Array.from(
      {length: 3},
      (_, index) =>
        new Promise<void>(resolve => {
          connected[index] = resolve;
        })
    );
    let calls = 0;
    async function transport() {
      connected[calls++]!();
      return new Promise<Response>(() => {});
    }

    const attempt = downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'connect-timeout',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    ).catch(error => error);
    for (let index = 0; index < 3; index++) {
      await connections[index];
      await vi.advanceTimersByTimeAsync(30000);
    }

    expect(await attempt).toMatchObject({code: 'NETWORK'});
    expect(calls).toBe(3);
    const inactive: (() => void)[] = [];
    const ready = Array.from(
      {length: 3},
      (_, index) =>
        new Promise<void>(resolve => {
          inactive[index] = resolve;
        })
    );
    calls = 0;
    const stalled = downloadUpdateCandidate(
      f.candidate,
      {
        directory: f.directory,
        trustedKeys: [keys.publicKey],
        transport: async () => {
          inactive[calls++]!();
          return new Response(new ReadableStream<Uint8Array>());
        },
      },
      'inactivity-timeout',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    ).catch(error => error);
    for (let index = 0; index < 3; index++) {
      await ready[index];
      await vi.advanceTimersByTimeAsync(120000);
    }

    expect(await stalled).toMatchObject({code: 'NETWORK'});
    expect(calls).toBe(3);
    let interval: ReturnType<typeof setInterval>;
    let reached!: () => void;
    const streaming = new Promise<void>(resolve => {
      reached = resolve;
    });
    calls = 0;
    const total = downloadUpdateCandidate(
      f.candidate,
      {
        directory: f.directory,
        trustedKeys: [keys.publicKey],
        transport: async () => {
          calls++;
          reached();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                interval = setInterval(
                  () => controller.enqueue(new Uint8Array([1])),
                  60000
                );
              },
              cancel() {
                clearInterval(interval);
              },
            })
          );
        },
      },
      'total-timeout',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    ).catch(error => error);
    await streaming;
    await vi.advanceTimersByTimeAsync(1800000);
    expect(await total).toMatchObject({code: 'NETWORK'});
    expect(calls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('rejects insecure and excessive redirects and honors Retry-After without automatic retries', async () => {
  const f = await fixture();
  const transport = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: {location: 'http://example.com/installer'},
      })
  );
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'insecure',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(transport).toHaveBeenCalledTimes(1);
  transport
    .mockClear()
    .mockImplementation(
      async () =>
        new Response(null, {status: 302, headers: {location: 'https://github.com/next'}})
    );
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'redirects',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(transport).toHaveBeenCalledTimes(6);
  transport
    .mockClear()
    .mockImplementation(
      async () => new Response(null, {status: 429, headers: {'retry-after': '120'}})
    );
  await expect(
    downloadUpdateCandidate(
      f.candidate,
      {directory: f.directory, trustedKeys: [keys.publicKey], transport},
      'rate-limited',
      {progress: () => {}, verifying: () => {}},
      new AbortController().signal
    )
  ).rejects.toMatchObject({code: 'RATE_LIMIT', retryAt: expect.any(Number)});
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  ['0.3.9', 'arm64'],
  ['0.4.0', 'amd64'],
])(
  'checks signed Debian version and architecture against actual archive %s %s',
  async (version, architecture) => {
    const f = await fixture('shop-things', version, architecture);
    await expect(
      downloadUpdateCandidate(
        f.candidate,
        {
          directory: f.directory,
          trustedKeys: [keys.publicKey],
          transport: async () => new Response(f.bytes),
        },
        'wrong-control',
        {progress: () => {}, verifying: () => {}},
        new AbortController().signal
      )
    ).rejects.toMatchObject({code: 'VERIFICATION'});
    expect(await readdir(join(f.directory, 'wrong-control'))).toEqual(['record.json']);
  }
);

function serviceFor(
  f: Awaited<ReturnType<typeof fixture>>,
  transport: (url: string, options: RequestInit) => Promise<Response>
) {
  return new UpdateDiscovery({
    appVersion: '0.3.1',
    packageVersion: '0.3.1',
    trustedKeys: [keys.publicKey],
    capabilityReasons: ['Installation is not available yet.'],
    download: {directory: f.directory, transport},
    request: async url => {
      if (url.startsWith('https://api.github.com/')) {
        return Buffer.from(
          JSON.stringify([
            {
              tag_name: 'v0.4.0',
              draft: false,
              prerelease: false,
              assets: [
                'shop-things-update-v1.json',
                'shop-things-update-v1.sig',
                'shop-things-0.4.0-linux-arm64.deb',
              ].map(name => ({
                name,
                browser_download_url: `https://github.com/nsdeschenes/shop-things/releases/download/v0.4.0/${name}`,
              })),
            },
          ])
        );
      }

      return url.endsWith('.json') ? f.candidate.bytes : f.candidate.signature;
    },
  });
}

test('only the current failed attempt can explicitly retry a fresh fully verified download', async () => {
  const f = await fixture();
  let failing = true;
  const transport = vi.fn(
    async () => new Response(failing ? f.bytes.subarray(0, 20) : f.bytes)
  );
  const discovery = serviceFor(f, transport);
  const checked = await discovery.check({});
  if (checked.status !== 'success') {
    throw new Error('Missing candidate');
  }

  expect(transport).not.toHaveBeenCalled();
  await discovery.start({candidateId: checked.value.candidateId!});
  await vi.waitFor(async () =>
    expect(await discovery.getState({})).toMatchObject({
      status: 'success',
      value: {phase: 'retryable-failure', errorCode: 'NETWORK', nextActions: ['retry']},
    })
  );
  expect(transport).toHaveBeenCalledTimes(3);
  const failed = await discovery.getState({});
  if (failed.status !== 'success') {
    throw new Error('Missing failure');
  }

  expect(await discovery.retry({attemptId: 'stale'})).toMatchObject({
    error: {code: 'VALIDATION'},
  });
  failing = false;
  const retried = await discovery.retry({attemptId: failed.value.attemptId!});
  expect(retried).toMatchObject({status: 'success', value: {phase: 'downloading'}});
  if (retried.status !== 'success') {
    throw new Error('Missing retry');
  }

  expect(retried.value.attemptId).not.toBe(failed.value.attemptId);
  await vi.waitFor(async () =>
    expect(await discovery.getState({})).toMatchObject({
      status: 'success',
      value: {phase: 'staged'},
    })
  );
  expect(transport).toHaveBeenCalledTimes(4);
  expect(await discovery.retry({attemptId: failed.value.attemptId!})).toMatchObject({
    error: {code: 'VALIDATION'},
  });
  const artifact = await discovery.getVerifiedArtifact(retried.value.attemptId!);
  if (!artifact) {
    throw new Error('Missing staged file');
  }

  await writeFile(artifact.path, 'altered after verification');
  await expect(
    discovery.getVerifiedArtifact(retried.value.attemptId!)
  ).rejects.toMatchObject({code: 'VERIFICATION'});
  expect(await discovery.getState({})).toMatchObject({
    status: 'success',
    value: {phase: 'retryable-failure', errorCode: 'VERIFICATION'},
  });
  expect(await readdir(join(f.directory, retried.value.attemptId!))).toEqual([
    'record.json',
  ]);
});

test('admitted customer work remains usable while an installer transfer waits', async () => {
  const f = await fixture();
  const backend = await import('./backendFixture.js');
  const database = await backend.fixture();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {
    finish = resolve;
  });
  const discovery = serviceFor(f, async () => {
    await gate;
    return new Response(f.bytes);
  });
  try {
    await database.service.start();
    const state = backend.success(await database.service.handlers['database.create']());
    const checked = await discovery.check({});
    if (checked.status !== 'success') {
      throw new Error('Missing candidate');
    }

    await discovery.start({candidateId: checked.value.candidateId!});
    const customer = backend.success(
      await database.service.handlers['customers.create']({
        session: state.session!,
        values: backend.values,
      })
    );
    expect(customer.customer.firstName).toBe('Anne');
    expect(
      backend.success(
        await database.service.handlers['customers.get']({
          session: state.session!,
          id: customer.customer.id,
        })
      ).customer.balance
    ).toBe('12.34');
    expect(await discovery.getState({})).toMatchObject({
      status: 'success',
      value: {phase: 'downloading'},
    });
    finish();
    await vi.waitFor(async () =>
      expect(await discovery.getState({})).toMatchObject({
        status: 'success',
        value: {phase: 'staged'},
      })
    );
  } finally {
    finish();
    discovery.stop();
    await database.cleanup();
  }
});
