import assert from 'node:assert/strict';
import {createPublicKey} from 'node:crypto';
export interface PublicUpdatePolicy {
  schemaVersion: 1;
  helperProtocol: 1;
  trustedKeys: string[];
}
export function validatePublicPolicy(value: unknown): PublicUpdatePolicy {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'helperProtocol',
    'schemaVersion',
    'trustedKeys',
  ]);
  assert.ok(
    'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'helperProtocol' in value &&
      value.helperProtocol === 1
  );
  assert.ok(
    'trustedKeys' in value &&
      Array.isArray(value.trustedKeys) &&
      value.trustedKeys.length > 0 &&
      value.trustedKeys.length <= 16
  );
  const trustedKeys = value.trustedKeys.map((pem: unknown) => {
    assert.ok(
      typeof pem === 'string' &&
        pem.length <= 4096 &&
        pem.startsWith('-----BEGIN PUBLIC KEY-----\n'),
      'Invalid publisher key. Only public SPKI publisher keys may be packaged'
    );
    const key = createPublicKey(pem);
    assert.equal(key.asymmetricKeyType, 'ed25519', 'Publisher key must be Ed25519');
    const canonical = key.export({type: 'spki', format: 'pem'}).toString();
    assert.ok(
      pem.trim() === canonical.trim(),
      'Publisher key must contain only public PEM'
    );
    return canonical;
  });
  assert.equal(new Set(trustedKeys).size, trustedKeys.length, 'Duplicate publisher key');
  return {schemaVersion: 1, helperProtocol: 1, trustedKeys};
}
