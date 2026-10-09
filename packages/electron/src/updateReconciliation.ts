import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {attemptPattern, protectedSystemFile} from './updateHelperProtocol.js';
import {parseUniqueJson, stableVersion} from './updateManifest.js';

export const transactionModulePath = '/usr/lib/shop-things/update/transaction.py';
const digestPattern = /^[a-f0-9]{64}$/;
export const receiptRoot = '/var/lib/shop-things-updater-receipts';
export interface PackageEvidence {
  outcome: 'clean' | 'installed' | 'unchanged' | 'uncertain';
  generation: number;
  state: string | null;
  receipt: {
    attemptId: string;
    manifestDigest: string;
    appVersion: string;
    packageVersion: string;
    resolution: 'administrator' | null;
    errorCode?: 'PACKAGE_LOCK' | 'TRANSACTION_REJECTED' | 'PACKAGE_RECOVERY' | null;
  } | null;
}
function rootReceiptError(
  value: unknown
): value is 'PACKAGE_LOCK' | 'TRANSACTION_REJECTED' | 'PACKAGE_RECOVERY' | null {
  return (
    value === null ||
    value === 'PACKAGE_LOCK' ||
    value === 'TRANSACTION_REJECTED' ||
    value === 'PACKAGE_RECOVERY'
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function inspectPackageEvidence(
  attemptId?: string
): Promise<PackageEvidence> {
  if (process.getuid?.() === 0 || (attemptId && !attemptPattern.test(attemptId))) {
    throw new Error('Package inspection requires the original desktop user.');
  }

  await protectedSystemFile(transactionModulePath, 1048576);
  const result = await promisify(execFile)(
    '/usr/bin/python3',
    [
      '-I',
      '-c',
      "import importlib.util,json,os,sys; s=importlib.util.spec_from_file_location('transaction','/usr/lib/shop-things/update/transaction.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.inspect(os.getuid(),sys.argv[1] or None),sort_keys=True,separators=(',',':')))",
      attemptId ?? '',
    ],
    {
      env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  const value: unknown = parseUniqueJson(result.stdout);
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'generation,outcome,receipt,state' ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.generation !== 'number' ||
    value.generation < 0 ||
    (value.outcome !== 'clean' &&
      value.outcome !== 'installed' &&
      value.outcome !== 'unchanged' &&
      value.outcome !== 'uncertain') ||
    (value.state !== null && !record(value.state))
  ) {
    throw new Error('Invalid protected package evidence.');
  }

  let receipt: PackageEvidence['receipt'] = null;
  if (value.receipt !== null) {
    const item = value.receipt;
    if (
      !record(item) ||
      typeof item.attemptId !== 'string' ||
      !attemptPattern.test(item.attemptId) ||
      typeof item.manifestDigest !== 'string' ||
      !digestPattern.test(item.manifestDigest) ||
      typeof item.appVersion !== 'string' ||
      item.appVersion.length > 128 ||
      !stableVersion.test(item.appVersion) ||
      (item.resolution !== null && item.resolution !== 'administrator') ||
      !rootReceiptError(item.errorCode) ||
      typeof item.packageVersion !== 'string' ||
      item.packageVersion.length > 128
    ) {
      throw new Error('Invalid protected attempt receipt.');
    }

    receipt = {
      attemptId: item.attemptId,
      manifestDigest: item.manifestDigest,
      appVersion: item.appVersion,
      packageVersion: item.packageVersion,
      resolution: item.resolution,
      errorCode: item.errorCode,
    };
  }

  return {
    outcome: value.outcome,
    generation: value.generation,
    state: value.state === null ? null : JSON.stringify(value.state),
    receipt,
  };
}
