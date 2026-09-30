/* oxlint-disable @tanstack/query/exhaustive-deps -- Scope controls request lifetime, not cache identity. */
/* oxlint-disable import/no-named-export -- Shared canonical query and mutation options. */
import type {
  ContractError,
  CreateCustomerInput,
  CustomerReference,
  UpdateCustomerInput,
} from '@shop-things/contract';
import {CancelledError, mutationOptions, queryOptions} from '@tanstack/react-query';

import type {Application, RequestScope} from './controller';

export class CustomerRequestError extends Error {
  readonly error: ContractError;

  constructor(error: ContractError) {
    super(error.message);
    this.error = error;
  }
}

export const customerKeys = {
  session: (session: string) => ['customers', session] as const,
  list: (session: string, query: string) =>
    ['customers', session, 'list', query] as const,
  detail: (session: string, id: number) => ['customers', session, 'detail', id] as const,
};

const readOptions = {
  staleTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
} as const;

function unwrap<T>(
  result:
    | {status: 'success'; value: T}
    | {status: 'error'; error: ContractError}
    | {status: 'cancelled'}
    | {status: 'obsolete'}
): T {
  if (result.status === 'success') {
    return result.value;
  }

  if (result.status === 'error') {
    throw new CustomerRequestError(result.error);
  }

  // IPC is already dispatched when cancellation becomes observable. Never cache its result.
  throw new CancelledError({silent: true, revert: true});
}

export function customerListOptions(
  application: Application,
  session: string,
  query: string,
  scope: RequestScope = {}
) {
  return queryOptions({
    ...readOptions,
    // Scope controls request lifetime, not saved customer cache identity.
    queryKey: customerKeys.list(session, query),
    queryFn: async ({signal}) =>
      unwrap(
        await application.request(
          session,
          client => client.customers.list({session, query}),
          {...scope, signal, coalesceKey: scope.coalesceKey ?? 'customers:list'}
        )
      ),
  });
}

export function customerDetailOptions(
  application: Application,
  session: string,
  id: number,
  scope: RequestScope = {}
) {
  return queryOptions({
    ...readOptions,
    // Scope controls request lifetime, not saved customer cache identity.
    queryKey: customerKeys.detail(session, id),
    queryFn: async ({signal}) =>
      unwrap(
        await application.request(
          session,
          client => client.customers.get({session, id}),
          {...scope, signal}
        )
      ),
  });
}

// Consumers suppress CancelledError feedback and check captureSession().isCurrent()
// immediately before cache writes, draft resets or success navigation.
export function createCustomerOptions(application: Application, session: string) {
  return mutationOptions({
    retry: false,
    mutationFn: async (values: CreateCustomerInput) =>
      unwrap(
        await application.request(session, client =>
          client.customers.create({session, values})
        )
      ),
  });
}

export function updateCustomerOptions(application: Application) {
  return mutationOptions({
    retry: false,
    mutationFn: async ({
      reference,
      changes,
    }: {
      reference: CustomerReference;
      changes: UpdateCustomerInput;
    }) =>
      unwrap(
        await application.request(reference.session, client =>
          client.customers.update({reference, changes})
        )
      ),
  });
}

export function deleteCustomerOptions(application: Application) {
  return mutationOptions({
    retry: false,
    mutationFn: async (reference: CustomerReference) =>
      unwrap(
        await application.request(reference.session, client =>
          client.customers.delete({reference})
        )
      ),
  });
}
