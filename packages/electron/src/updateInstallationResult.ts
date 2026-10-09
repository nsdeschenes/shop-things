import type {UpdateState} from '@shop-things/contract';
export type InstallResult =
  | 'retryable'
  | 'package-lock'
  | 'transaction-rejected'
  | 'verification-rejected'
  | 'recovery'
  | 'restarting';
export function retryableInstallation(result: InstallResult | 'ready') {
  return [
    'retryable',
    'package-lock',
    'transaction-rejected',
    'verification-rejected',
  ].includes(result);
}

export function installationErrorCode(
  result: InstallResult | 'ready'
): UpdateState['errorCode'] {
  return result === 'package-lock'
    ? 'PACKAGE_LOCK'
    : result === 'transaction-rejected'
      ? 'TRANSACTION_REJECTED'
      : result === 'verification-rejected'
        ? 'VERIFICATION'
        : result === 'recovery'
          ? 'PACKAGE_UNCERTAIN'
          : 'AUTHENTICATION';
}
