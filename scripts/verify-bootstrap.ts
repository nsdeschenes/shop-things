import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';

import {parseUniqueJson, stableVersion} from '../packages/electron/src/updateManifest.ts';
import {validatePublicPolicy} from './updateRelease.ts';
import {runIfMain} from './workspace.ts';

const execute = promisify(execFile);
const decimal = /^\d+$/;
const field = /^([^:\s]+): (.*)$/;
export const legacyIdentity = {
  version: '0.3.1',
  maintainer: 'Shop Things contributors <nsdeschenes@users.noreply.github.com>',
  homepage: 'https://github.com/nsdeschenes/shop-things',
  description: 'Customer records and saved database workflows',
  scripts: [
    {
      path: '/var/lib/dpkg/info/electron.postinst',
      size: 2969,
      sha256: '975aaf3f3a2f1d7888d6b4183314cafba800c6568749819adadbab0e5730a883',
    },
    {
      path: '/var/lib/dpkg/info/electron.postrm',
      size: 1122,
      sha256: '79bf1f304249e5559d1e9f323962c351a92f5b12f581ed87add585156d913e88',
    },
  ],
  files: [
    {
      path: '/opt/Shop Things/shop-things',
      size: 220794248,
      sha256: 'eef9f514bd881987114fb445e36810d08ff3b37f9fa03170c8343b3b0a646c74',
    },
    {
      path: '/opt/Shop Things/resources/app.asar',
      size: 22157777,
      sha256: '89200953d5fc74b602a8d743a08492dd3cc7b871ef0bc1d1151bf69ed112e328',
    },
    {
      path: '/opt/Shop Things/resources/app.asar.unpacked/node_modules/@tursodatabase/database-linux-arm64-gnu/turso.linux-arm64-gnu.node',
      size: 106238952,
      sha256: 'e2f898f102f62a2d2498d3a000782bba5b29ebe5c2003131af495de53323bb82',
    },
    {
      path: '/usr/share/applications/shop-things.desktop',
      size: 222,
      sha256: 'f9e1d66db3f0fc92ad8b9abe3aea999a25d40e3383489c815f39aad26a2c9e9e',
    },
  ],
};

type Options = {root?: string; ownerUid?: number; legacy?: typeof legacyIdentity};
type Result = {
  kind:
    | 'fresh'
    | 'verified-legacy'
    | 'verified-bootstrap'
    | 'unrelated-electron'
    | 'unsafe';
  diagnostics: string[];
  shutdownConsent: 'operator-required';
  appVersion?: string;
};

export async function readPackagedIdentity(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const prefix = Buffer.alloc(16);
    if (
      (await file.read(prefix, 0, 16, 0)).bytesRead !== 16 ||
      prefix.readUInt32LE(0) !== 4
    ) {
      throw new Error('Invalid installed ASAR header.');
    }

    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize > 8 * 1024 * 1024 || headerSize < 8 || jsonSize > headerSize - 8) {
      throw new Error('Unbounded installed ASAR header.');
    }

    const header = Buffer.alloc(jsonSize);
    if ((await file.read(header, 0, jsonSize, 16)).bytesRead !== jsonSize) {
      throw new Error('Truncated installed ASAR header.');
    }

    const entry = JSON.parse(header.toString('utf8')).files?.['package.json'];
    if (
      !entry ||
      entry.unpacked ||
      entry.link ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 4096 ||
      typeof entry.offset !== 'string' ||
      !decimal.test(entry.offset)
    ) {
      throw new Error('Invalid packaged application metadata.');
    }

    const start = 8 + headerSize + Number(entry.offset);
    if (!Number.isSafeInteger(start) || start + entry.size > (await file.stat()).size) {
      throw new Error('Truncated packaged application metadata.');
    }

    const bytes = Buffer.alloc(entry.size);
    if ((await file.read(bytes, 0, entry.size, start)).bytesRead !== entry.size) {
      throw new Error('Truncated packaged application metadata.');
    }

    const value = JSON.parse(bytes.toString('utf8'));
    if (
      value.name !== 'electron' ||
      (value.productName ?? 'electron') !== 'electron' ||
      typeof value.version !== 'string'
    ) {
      throw new Error('Runtime application identity changed.');
    }

    return {name: value.name as string, version: value.version as string};
  } finally {
    await file.close();
  }
}

// Options are a read-only filesystem fixture seam; the operator CLI always uses the
// fixed system paths/UID/trust anchor. This tool cannot authorize or mutate packages.
export async function inspectBootstrap(options: Options = {}): Promise<Result> {
  const root = resolve(options.root ?? '/');
  const uid = options.ownerUid ?? 0;
  const legacy = options.legacy ?? legacyIdentity;
  const env = {PATH: '/usr/bin:/bin', LC_ALL: 'C'};
  async function query(args: string[]) {
    return execute(
      '/usr/bin/dpkg-query',
      ['--admindir=' + join(root, 'var/lib/dpkg'), ...args],
      {env, timeout: 30000, maxBuffer: 65536}
    );
  }

  async function metadata(name: string) {
    try {
      const {stdout} = await query(['--status', name]);
      const fields: Record<string, string> = {};
      let previous: string | undefined;
      for (const line of stdout.trimEnd().split('\n')) {
        if (previous && (line.startsWith(' ') || line.startsWith('\t'))) {
          fields[previous] += '\n' + line.slice(1);
          continue;
        }

        const match = field.exec(line);
        if (!match || Object.hasOwn(fields, match[1]!)) {
          throw new Error('Unsupported package metadata.');
        }

        previous = match[1]!;
        fields[previous] = match[2]!;
      }

      for (const key of Object.keys(fields)) {
        fields[key] = fields[key]!.trim();
      }

      return fields;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 1 &&
        'stdout' in error &&
        error.stdout === ''
      ) {
        return null;
      }

      throw error;
    }
  }

  async function protectedFile(path: string, maximum: number, read = false) {
    const actual = join(root, path);
    for (const parent of [
      root,
      ...relative(root, dirname(actual))
        .split(sep)
        .filter(Boolean)
        .map((_, index, parts) => join(root, ...parts.slice(0, index + 1))),
    ]) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.uid !== uid || info.mode & 0o022) {
        throw new Error('Unprotected installed directory: ' + path);
      }
    }

    const before = await lstat(actual);
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.mode & 0o022 ||
      before.nlink !== 1 ||
      before.size > maximum
    ) {
      throw new Error('Unprotected installed file: ' + path);
    }

    const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (info.dev !== before.dev || info.ino !== before.ino) {
        throw new Error('Installed file changed: ' + path);
      }

      if (read) {
        const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
          await file.readFile()
        );
        const after = await file.stat();
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs
        ) {
          throw new Error('Installed file changed: ' + path);
        }

        return {size: info.size, text};
      }

      const hash = createHash('sha256');
      for await (const bytes of file.createReadStream({autoClose: false})) {
        hash.update(bytes);
      }

      const after = await file.stat();
      if (
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      ) {
        throw new Error('Installed file changed: ' + path);
      }

      return {size: info.size, sha256: hash.digest('hex')};
    } finally {
      await file.close();
    }
  }

  async function owned(path: string, name: string) {
    await protectedFile('/var/lib/dpkg/info/' + name + '.list', 16 * 1024 * 1024);
    const {stdout} = await query(['--search', path]);
    const allowed = new Set([`${name}: ${path}`, `${name}:arm64: ${path}`]);
    if (!allowed.has(stdout.trim())) {
      throw new Error('Unexpected package ownership: ' + path);
    }
  }

  function result(kind: Result['kind'], diagnostics: string[] = []): Result {
    return {kind, diagnostics, shutdownConsent: 'operator-required'};
  }

  try {
    await protectedFile('/var/lib/dpkg/status', 16 * 1024 * 1024);
    const old = await metadata('electron');
    const current = await metadata('shop-things');
    const oldInstalled =
      old &&
      old.Status !== 'deinstall ok config-files' &&
      old.Status !== 'unknown ok not-installed';
    const currentInstalled =
      current &&
      current.Status !== 'deinstall ok config-files' &&
      current.Status !== 'unknown ok not-installed';
    if (currentInstalled) {
      if (
        current.Status !== 'install ok installed' ||
        current.Architecture !== 'arm64' ||
        current.Package !== 'shop-things'
      ) {
        throw new Error('Bootstrap is not configured ARM64 shop-things.');
      }

      for (const path of [
        '/opt/Shop Things/shop-things',
        '/opt/Shop Things/resources/app.asar',
        '/usr/share/applications/shop-things.desktop',
      ]) {
        await owned(path, 'shop-things');
        await protectedFile(path, 1073741824);
      }

      for (const path of [
        '/usr/lib/shop-things/updater-helper',
        '/usr/lib/shop-things/update-supervisor',
        '/usr/lib/shop-things/update/identity.json',
        '/usr/share/polkit-1/actions/com.shopthings.app.update.policy',
      ]) {
        await protectedFile(path, 1048576);
      }

      const identityText = (
        await protectedFile('/usr/lib/shop-things/update/identity.json', 4096, true)
      ).text!;
      const identity = parseUniqueJson(identityText) as Record<string, unknown>;
      if (
        Object.keys(identity).sort().join(',') !==
          'appVersion,packageName,schemaVersion' ||
        identity.schemaVersion !== 1 ||
        identity.packageName !== 'shop-things' ||
        typeof identity.appVersion !== 'string' ||
        !stableVersion.test(identity.appVersion)
      ) {
        throw new Error('Invalid installed app identity.');
      }

      const policyPath = '/usr/lib/shop-things/update/policy.json';
      let policyExists = false;
      try {
        await lstat(join(root, policyPath));
        policyExists = true;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw new Error('Installed public policy could not be inspected.');
        }
      }

      if (policyExists) {
        try {
          const policy = await protectedFile(policyPath, 65536, true);
          validatePublicPolicy(parseUniqueJson(policy.text!));
        } catch {
          throw new Error('Installed public policy is invalid or unprotected.');
        }
      }

      const packaged = await readPackagedIdentity(
        join(root, '/opt/Shop Things/resources/app.asar')
      );
      if (packaged.version !== identity.appVersion) {
        throw new Error('Protected identity and installed application disagree.');
      }

      return {
        ...result('verified-bootstrap', [
          'Read-only package/layout identity verified; desktop authentication and runtime capability qualification remain separate.',
        ]),
        appVersion: identity.appVersion,
      };
    }

    if (oldInstalled) {
      if (
        old.Package !== 'electron' ||
        old.Version !== legacy.version ||
        old.Architecture !== 'arm64' ||
        old.Maintainer !== legacy.maintainer ||
        old.Vendor !== legacy.maintainer ||
        old.Homepage !== legacy.homepage ||
        old.Description !== legacy.description
      ) {
        return result('unrelated-electron', [
          'This electron installation is not the inspected Shop Things legacy release. Do not remove it.',
        ]);
      }

      if (old.Status !== 'install ok installed') {
        throw new Error('Legacy package is not configured.');
      }

      for (const expected of legacy.files) {
        await owned(expected.path, 'electron');
        const actual = await protectedFile(expected.path, expected.size);
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
          throw new Error(
            'Legacy bytes do not match the inspected release: ' + expected.path
          );
        }
      }

      for (const expected of legacy.scripts) {
        const actual = await protectedFile(expected.path, expected.size);
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
          throw new Error('Legacy maintainer script differs from the inspected release.');
        }
      }

      return result('verified-legacy', [
        'Exact known legacy identity observed. Normal guarded Quit and immediate revalidation are required before operator removal.',
      ]);
    }

    const sharedPaths = [
      ...legacy.files.map(file => file.path),
      '/usr/bin/shop-things',
      '/etc/apparmor.d/shop-things',
      '/usr/lib/shop-things/updater-helper',
      '/usr/lib/shop-things/update-supervisor',
      '/usr/lib/shop-things/update/identity.json',
      '/usr/share/polkit-1/actions/com.shopthings.app.update.policy',
    ];
    for (const path of sharedPaths) {
      try {
        await lstat(join(root, path));
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue;
        }

        throw error;
      }

      throw new Error('A shared installation path already exists: ' + path);
    }

    return result('fresh');
  } catch (error) {
    return result('unsafe', [
      error instanceof Error
        ? error.message
        : 'Installed identity could not be verified.',
    ]);
  }
}

await runIfMain(import.meta.url, async () => {
  if (process.argv.length !== 2) {
    throw new Error('Usage: node --experimental-strip-types scripts/verify-bootstrap.ts');
  }

  const result = await inspectBootstrap();
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'unsafe' || result.kind === 'unrelated-electron') {
    process.exitCode = 1;
  }
});
