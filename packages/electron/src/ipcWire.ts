export const controls = {
  updateSubscribe: 'shop-things:update-subscribe',
  updateUnsubscribe: 'shop-things:update-unsubscribe',
  updateChanged: 'shop-things:update-changed',
  handshake: 'shop-things:document',
  stateSubscribe: 'shop-things:state-subscribe',
  stateUnsubscribe: 'shop-things:state-unsubscribe',
  stateChanged: 'shop-things:state-changed',
  draftRegister: 'shop-things:draft-register',
  draftUnregister: 'shop-things:draft-unregister',
  draftPrepare: 'shop-things:draft-prepare',
  draftResolve: 'shop-things:draft-resolve',
  draftReply: 'shop-things:draft-reply',
  draftFailure: 'shop-things:draft-failure',
};

export function isRecord(
  value: unknown,
  keys: string[]
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface Validator<T> {
  safeParse(value: unknown): {success: true; data: T} | {success: false; error: unknown};
}

const updateToken = /^[A-Za-z0-9_-]+$/;
export function isUpdateToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    updateToken.test(value)
  );
}
