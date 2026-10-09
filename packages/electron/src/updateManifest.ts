import {createPublicKey, verify, type KeyObject} from 'node:crypto';

const debianEpoch = /^\d+$/;
const debianUpstream = /^\d[A-Za-z0-9.+~:-]*$/;
const debianRevision = /^[A-Za-z0-9.+~]+$/;
const digest = /^[a-f0-9]{64}$/;
const jsonWhitespace = /[\t\n\r ]/;
const jsonPrimitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

export interface UpdateManifest {
  schemaVersion: 1;
  applicationId: 'com.shopthings.app';
  repository: 'nsdeschenes/shop-things';
  channel: 'stable';
  appVersion: string;
  packageName: 'shop-things';
  packageVersion: string;
  platform: 'linux';
  architecture: 'arm64';
  helperProtocol: {min: 1; max: 1};
  artifact: {filename: string; byteLength: number; sha256: string};
}

export const stableVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

export function verifyUpdateManifest(
  bytes: Uint8Array,
  signature: Uint8Array,
  trustedKeys: readonly (KeyObject | string)[]
): UpdateManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > 65536 || signature.byteLength !== 64) {
    throw new Error('Invalid update manifest bounds.');
  }

  if (
    !trustedKeys.some(value => {
      const key = typeof value === 'string' ? createPublicKey(value) : value;
      return key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signature);
    })
  ) {
    throw new Error('The update signature is not trusted.');
  }

  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  const value: unknown = parseUniqueJson(text);
  if (
    !object(value, [
      'schemaVersion',
      'applicationId',
      'repository',
      'channel',
      'appVersion',
      'packageName',
      'packageVersion',
      'platform',
      'architecture',
      'helperProtocol',
      'artifact',
    ]) ||
    value.schemaVersion !== 1 ||
    value.applicationId !== 'com.shopthings.app' ||
    value.repository !== 'nsdeschenes/shop-things' ||
    value.channel !== 'stable' ||
    value.packageName !== 'shop-things' ||
    value.platform !== 'linux' ||
    value.architecture !== 'arm64' ||
    typeof value.appVersion !== 'string' ||
    value.appVersion.length > 128 ||
    !stableVersion.test(value.appVersion) ||
    typeof value.packageVersion !== 'string' ||
    value.packageVersion.length > 128 ||
    !isDebianVersion(value.packageVersion) ||
    !object(value.helperProtocol, ['min', 'max']) ||
    value.helperProtocol.min !== 1 ||
    value.helperProtocol.max !== 1 ||
    !object(value.artifact, ['filename', 'byteLength', 'sha256']) ||
    value.artifact.filename !== `shop-things-${value.appVersion}-linux-arm64.deb` ||
    typeof value.artifact.byteLength !== 'number' ||
    !Number.isSafeInteger(value.artifact.byteLength) ||
    value.artifact.byteLength <= 0 ||
    value.artifact.byteLength > 1073741824 ||
    typeof value.artifact.sha256 !== 'string' ||
    !digest.test(value.artifact.sha256)
  ) {
    throw new Error('Invalid update manifest identity or schema.');
  }

  return {
    schemaVersion: 1,
    applicationId: 'com.shopthings.app',
    repository: 'nsdeschenes/shop-things',
    channel: 'stable',
    appVersion: value.appVersion,
    packageName: 'shop-things',
    packageVersion: value.packageVersion,
    platform: 'linux',
    architecture: 'arm64',
    helperProtocol: {min: 1, max: 1},
    artifact: {
      filename: value.artifact.filename,
      byteLength: value.artifact.byteLength,
      sha256: value.artifact.sha256,
    },
  };
}

// Parse before JSON.parse can erase duplicate object keys, including escaped aliases.
export function parseUniqueJson(text: string): unknown {
  let position = 0;
  function whitespace() {
    while (jsonWhitespace.test(text[position] ?? '\0')) {
      position++;
    }
  }

  function string(): string {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '\\') {
        position++;
      } else if (char === '"') {
        return JSON.parse(text.slice(start, position));
      }
    }

    throw new Error('Unterminated JSON string.');
  }

  function value(depth: number): unknown {
    if (depth > 32) {
      throw new Error('Update manifest is too deeply nested.');
    }

    whitespace();
    if (text[position] === '"') {
      return string();
    }

    if (text[position] === '{') {
      position++;
      const result: Record<string, unknown> = Object.create(null);
      whitespace();
      if (text[position] === '}') {
        position++;
        return result;
      }

      while (true) {
        whitespace();
        if (text[position] !== '"') {
          throw new Error('Expected JSON key.');
        }

        const key = string();
        if (Object.hasOwn(result, key)) {
          throw new Error('Duplicate JSON key.');
        }

        whitespace();
        if (text[position++] !== ':') {
          throw new Error('Expected JSON colon.');
        }

        result[key] = value(depth + 1);
        whitespace();
        const next = text[position++];
        if (next === '}') {
          return result;
        }

        if (next !== ',') {
          throw new Error('Expected JSON separator.');
        }
      }
    }

    if (text[position] === '[') {
      position++;
      const result: unknown[] = [];
      whitespace();
      if (text[position] === ']') {
        position++;
        return result;
      }

      while (true) {
        result.push(value(depth + 1));
        whitespace();
        const next = text[position++];
        if (next === ']') {
          return result;
        }

        if (next !== ',') {
          throw new Error('Expected JSON separator.');
        }
      }
    }

    const match = jsonPrimitive.exec(text.slice(position));
    if (!match) {
      throw new Error('Invalid JSON value.');
    }

    position += match[0].length;
    return JSON.parse(match[0]);
  }

  const result = value(0);
  whitespace();
  if (position !== text.length) {
    throw new Error('Trailing JSON data.');
  }

  return result;
}

function isDebianVersion(version: string): boolean {
  const colon = version.indexOf(':');
  if (colon >= 0 && !debianEpoch.test(version.slice(0, colon))) {
    return false;
  }

  const rest = colon >= 0 ? version.slice(colon + 1) : version;
  const hyphen = rest.lastIndexOf('-');
  const upstream = hyphen >= 0 ? rest.slice(0, hyphen) : rest;
  return (
    debianUpstream.test(upstream) &&
    (hyphen < 0 || debianRevision.test(rest.slice(hyphen + 1)))
  );
}
