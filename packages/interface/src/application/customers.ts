/* oxlint-disable import/no-named-export -- Shared canonical query and mutation options. */
import type {
  ContractError,
  CreateCustomerInput,
  CustomerReference,
  CustomerRecord,
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
  lists: (session: string) => ['customers', session, 'list'] as const,
  list: (session: string, query: string) =>
    ['customers', session, 'list', query] as const,
  detail: (session: string, id: number) => ['customers', session, 'detail', id] as const,
};

const readOptions = {
  staleTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: true,
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
    meta: {requestScope: scope},
    queryFn: async ({signal, meta}) =>
      unwrap(
        await application.read(
          session,
          client => client.customers.list({session, query}),
          {
            ...meta?.requestScope,
            signal,
            coalesceKey: meta?.requestScope?.coalesceKey ?? 'customers:list',
          }
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
    meta: {requestScope: scope},
    queryFn: async ({signal, meta}) =>
      unwrap(
        await application.read(session, client => client.customers.get({session, id}), {
          ...meta?.requestScope,
          signal,
        })
      ),
  });
}

// Invalidate only saved data; editor drafts remain owned by draft protection.
export async function refreshSavedCustomers(application: Application, session: string) {
  const captured = application.captureSession(session);
  if (!captured.isCurrent()) {
    return false;
  }

  await application.queryClient.invalidateQueries({
    queryKey: customerKeys.session(session),
    refetchType: 'none',
  });
  if (!captured.isCurrent()) {
    return false;
  }

  await application.queryClient.fetchQuery(customerListOptions(application, session, ''));
  return captured.isCurrent();
}

async function adoptSavedCustomer(
  application: Application,
  record: CustomerRecord,
  captured: ReturnType<Application['captureSession']>
) {
  if (!captured.isCurrent()) {
    return;
  }

  application.queryClient.setQueryData(
    customerKeys.detail(captured.session, record.customer.id),
    record
  );
  await application.queryClient.invalidateQueries({
    queryKey: customerKeys.lists(captured.session),
  });
}

// Consumers suppress CancelledError feedback and check captureSession().isCurrent()
// immediately before draft resets or success navigation.
export function createCustomerOptions(application: Application, session: string) {
  return mutationOptions({
    retry: false,
    onMutate: () => application.captureSession(session),
    onSuccess: (record, _values, captured) =>
      adoptSavedCustomer(application, record, captured),
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
    onMutate: ({reference}) => application.captureSession(reference.session),
    onSuccess: (record, _values, captured) =>
      adoptSavedCustomer(application, record, captured),
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
    onMutate: reference => application.captureSession(reference.session),
    onSuccess: async (_result, reference, captured) => {
      if (!captured.isCurrent()) {
        return;
      }

      application.queryClient.removeQueries({
        queryKey: customerKeys.detail(captured.session, reference.id),
      });
      await application.queryClient.invalidateQueries({
        queryKey: customerKeys.lists(captured.session),
      });
    },
    mutationFn: async (reference: CustomerReference) =>
      unwrap(
        await application.request(reference.session, client =>
          client.customers.delete({reference})
        )
      ),
  });
}
