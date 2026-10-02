/* oxlint-disable import/no-named-export -- Application bootstrap and shared state owner. */
import type {ToastManager} from '@base-ui/react/toast';
import type {
  Client,
  DatabaseState,
  DraftRequest,
  CustomerTarget,
  CustomerRecord,
} from '@shop-things/contract';
import {applyNewerDatabaseState, getClient} from '@shop-things/contract/client';
import {CancelledError, QueryClient} from '@tanstack/react-query';

import {CustomerRequestError, customerKeys} from './customers';
import createPreviewClient from './preview';
import {createDraftProtection} from './protection';
import toastManager, {createToasts} from './toasts';

export interface ApplicationState {
  mode: 'live' | 'preview' | 'unavailable';
  phase: 'loading' | 'ready' | 'error';
  database: DatabaseState | null;
  error: string | null;
  pendingTransition: boolean;
  reconciling: boolean;
  recoveryRequired: boolean;
  pendingFile: string | null;
  refreshingCustomers: boolean;
  refreshError: string | null;
}

export interface RequestScope {
  signal?: AbortSignal;
  isRelevant?: () => boolean;
  coalesceKey?: string;
  navigationReadToken?: string;
}

export const obsolete = {status: 'obsolete'} as const;
const unavailable = {
  status: 'error',
  error: {
    code: 'DATABASE_UNAVAILABLE',
    message: 'Wait for an available database before trying again.',
  },
} as const;
const busy = {
  status: 'error',
  error: {
    code: 'BUSY',
    message: 'Wait for the current operation to finish, then try again.',
  },
} as const;

export function createApplication(
  url: string,
  attached = Reflect.has(window, 'shopThings'),
  options: {client?: Client; queryClient?: QueryClient; toastManager?: ToastManager} = {}
) {
  const notifications = options.toastManager ?? toastManager;
  const toasts = createToasts(notifications);
  const mode = attached
    ? 'live'
    : new URL(url).searchParams.get('preview') === 'true'
      ? 'preview'
      : 'unavailable';
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: {retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false},
        mutations: {retry: false},
      },
    });
  let client: Client | null = options.client ?? null;
  const protection = createDraftProtection(() => client);
  let state: ApplicationState = {
    mode,
    phase: 'loading',
    database: null,
    error: null,
    pendingTransition: false,
    reconciling: false,
    recoveryRequired: false,
    pendingFile: null,
    refreshingCustomers: false,
    refreshError: null,
  };
  let generation = 0;
  let stopState: (() => void) | null = null;
  let stopProtection: (() => void) | null = null;
  let protectionRequest: DraftRequest | null = null;
  let pendingSessionChange: {
    database: DatabaseState;
    previousSession: string | null;
  } | null = null;
  let lastAvailableSession: string | null = null;
  let reconcilePromise: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const searches = new Map<string, object>();
  const listeners = new Set<() => void>();
  const refreshListeners = new Set<() => Promise<void>>();
  const sessionListeners = new Set<(database: DatabaseState) => void>();

  function publish(next: ApplicationState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function flushSessionChange() {
    if (
      !pendingSessionChange ||
      protectionRequest ||
      state.pendingTransition ||
      state.pendingFile
    ) {
      return;
    }

    const {database, previousSession} = pendingSessionChange;
    pendingSessionChange = null;
    if (previousSession !== null) {
      void queryClient.cancelQueries({queryKey: ['customers', previousSession]});
      queryClient.removeQueries({queryKey: ['customers', previousSession]});
    }

    for (const listener of sessionListeners) {
      listener(database);
    }
  }

  function acceptDatabase(database: DatabaseState) {
    const previous = state.database;
    const accepted = applyNewerDatabaseState(previous, database);
    if (accepted === previous) {
      return;
    }

    publish({
      ...state,
      database: accepted,
      refreshError: previous?.session === accepted.session ? state.refreshError : null,
    });
    // An unavailable state retains the route/draft. A new available session resets it.
    if (
      previous !== null &&
      accepted.available &&
      previous.session !== accepted.session
    ) {
      pendingSessionChange = {database: accepted, previousSession: lastAvailableSession};
      flushSessionChange();
    }

    if (accepted.available) {
      lastAvailableSession = accepted.session;
    }
  }

  function isCurrentSession(session: string) {
    return (
      state.phase === 'ready' &&
      state.database?.available === true &&
      state.database.session === session
    );
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function reconcile() {
    if (reconcilePromise) {
      return reconcilePromise;
    }

    const attempt = generation;
    publish({...state, reconciling: true, recoveryRequired: true});
    reconcilePromise = (async () => {
      try {
        const result = await client?.database.status();
        if (attempt !== generation) {
          return;
        }

        if (result?.status === 'success') {
          acceptDatabase(result.value);
          publish({...state, recoveryRequired: false, error: null});
        } else {
          publish({
            ...state,
            error:
              result?.status === 'error'
                ? result.error.message
                : 'Could not check the database. Try again.',
          });
        }
      } finally {
        if (attempt === generation) {
          reconcilePromise = null;
          publish({...state, reconciling: false});
        }
      }
    })();
    return reconcilePromise;
  }

  async function coordinatedRequest<T extends {status: string}>(
    session: string,
    operation: (client: Client) => Promise<T>,
    scope: RequestScope = {},
    replacement?: () => boolean
  ): Promise<T | typeof obsolete | typeof unavailable | typeof busy> {
    if (!isCurrentSession(session) || !client || state.recoveryRequired) {
      return unavailable;
    }

    if (
      state.pendingFile ||
      state.pendingTransition ||
      state.reconciling ||
      protectionRequest ||
      (protection.getState().frozen && !replacement?.())
    ) {
      return busy;
    }

    const attempt = generation;
    const token = {};
    if (scope.coalesceKey) {
      searches.set(scope.coalesceKey, token);
    }

    function relevant() {
      return (
        attempt === generation &&
        isCurrentSession(session) &&
        !scope.signal?.aborted &&
        (scope.isRelevant?.() ?? true) &&
        (!replacement || replacement()) &&
        (!scope.coalesceKey || searches.get(scope.coalesceKey) === token)
      );
    }

    return serialize(async () => {
      try {
        if (!relevant()) {
          return obsolete;
        }

        if (state.recoveryRequired) {
          return unavailable;
        }

        if (
          state.pendingFile ||
          state.pendingTransition ||
          protectionRequest ||
          state.reconciling ||
          (protection.getState().frozen && !replacement?.())
        ) {
          return busy;
        }

        const result = await operation(client!);
        if (!relevant()) {
          return obsolete;
        }

        if (result.status === 'error' && 'error' in result) {
          const error = result.error;
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'STALE_SESSION' || error.code === 'DATABASE_UNAVAILABLE')
          ) {
            await reconcile();
            if (!relevant()) {
              return obsolete;
            }
          }
        }

        return result;
      } finally {
        if (scope.coalesceKey && searches.get(scope.coalesceKey) === token) {
          searches.delete(scope.coalesceKey);
        }
      }
    });
  }

  function request<T extends {status: string}>(
    session: string,
    operation: (client: Client) => Promise<T>,
    scope: RequestScope = {}
  ) {
    return coordinatedRequest(session, operation, scope);
  }

  async function reloadCustomer(
    target: CustomerTarget,
    commit: (record: CustomerRecord) => void
  ) {
    if (!isCurrentSession(target.session) || !client || state.recoveryRequired) {
      throw new CustomerRequestError(unavailable.error);
    }

    if (state.pendingTransition || state.reconciling || protectionRequest) {
      throw new CustomerRequestError(busy.error);
    }

    const attempt = generation;
    return protection.replaceDraft(
      async replacement => {
        const result = await coordinatedRequest(
          target.session,
          client => client.customers.get({session: target.session, id: target.id}),
          {isRelevant: replacement},
          replacement
        );
        if (result.status === 'error') {
          throw new CustomerRequestError(result.error);
        }

        if (result.status !== 'success') {
          throw new CancelledError({silent: true});
        }

        return result.value;
      },
      record => {
        if (attempt !== generation || !isCurrentSession(target.session)) {
          throw new CancelledError({silent: true});
        }

        commit(record);
        queryClient.removeQueries({queryKey: ['customers', target.session, 'list']});
      }
    );
  }

  async function refreshCustomers() {
    const session = state.database?.session;
    const draft = protection.getState();
    if (
      !session ||
      !isCurrentSession(session) ||
      state.recoveryRequired ||
      state.pendingFile ||
      state.pendingTransition ||
      state.reconciling ||
      state.refreshingCustomers ||
      draft.frozen ||
      draft.saving ||
      protection.isDirty()
    ) {
      return;
    }

    const captured = {generation, session};
    function current() {
      return captured.generation === generation && isCurrentSession(captured.session);
    }

    publish({...state, refreshingCustomers: true, refreshError: null});
    notifications.close('customer-refresh');
    try {
      const filter = {queryKey: customerKeys.session(session)};
      await queryClient.cancelQueries(filter);
      await queryClient.invalidateQueries({...filter, refetchType: 'none'});
      let failure: unknown;
      // List searches share a request coalescing key. Refresh visible queries in order.
      for (const query of queryClient
        .getQueryCache()
        .findAll({...filter, type: 'active'})) {
        if (!current()) {
          return;
        }

        try {
          await queryClient.refetchQueries(
            {queryKey: query.queryKey, exact: true, type: 'active'},
            {throwOnError: true}
          );
        } catch (error) {
          failure ??= error;
        }
      }

      if (!current()) {
        return;
      }

      for (const listener of refreshListeners) {
        if (!current()) {
          return;
        }

        try {
          await listener();
        } catch (error) {
          failure ??= error;
        }
      }

      if (failure) {
        throw failure;
      }
    } catch (failure) {
      if (current()) {
        const message =
          failure instanceof Error
            ? failure.message
            : 'Could not refresh customers. Try again.';
        publish({...state, refreshError: message});
        toasts.error({
          id: 'customer-refresh',
          title: 'Could not refresh customers',
          description: message,
        });
      }
    } finally {
      if (captured.generation === generation) {
        publish({...state, refreshingCustomers: false});
      }
    }
  }

  async function transition(action: 'create' | 'open' | 'restore' | 'retry') {
    if (!client || state.phase !== 'ready') {
      return unavailable;
    }

    if (
      state.pendingTransition ||
      state.refreshingCustomers ||
      state.reconciling ||
      protectionRequest ||
      protection.getState().frozen
    ) {
      return busy;
    }

    const attempt = generation;
    publish({...state, pendingTransition: true, error: null});
    try {
      return await serialize(async () => {
        if (attempt !== generation) {
          return obsolete;
        }

        const result = await client!.database[action]();
        if (attempt !== generation) {
          return obsolete;
        }

        if (result.status === 'success') {
          acceptDatabase(result.value);
          publish({...state, recoveryRequired: false, error: null});
        }

        return result;
      });
    } finally {
      if (attempt === generation) {
        publish({...state, pendingTransition: false});
        flushSessionChange();
      }
    }
  }

  async function fileAction(
    action: 'create' | 'open' | 'retry' | 'restore' | 'backup' | 'export'
  ) {
    if (
      state.pendingFile ||
      state.refreshingCustomers ||
      state.pendingTransition ||
      state.phase !== 'ready' ||
      protection.getState().frozen ||
      protection.getState().saving ||
      state.reconciling
    ) {
      return;
    }

    const attempt = generation;
    notifications.close('database-feedback');

    publish({...state, pendingFile: action});
    try {
      const session = state.database?.session;
      const result =
        action === 'backup' || action === 'export'
          ? await serialize(async () => {
              if (
                !session ||
                !client ||
                !isCurrentSession(session) ||
                state.recoveryRequired
              ) {
                return unavailable;
              }

              const result =
                action === 'backup'
                  ? await client.database.backup({session})
                  : await client.exports.csv({session});
              if (attempt !== generation || !isCurrentSession(session)) {
                return obsolete;
              }

              if (
                result.status === 'error' &&
                (result.error.code === 'STALE_SESSION' ||
                  result.error.code === 'DATABASE_UNAVAILABLE')
              ) {
                await reconcile();
                if (attempt !== generation || !isCurrentSession(session)) {
                  return obsolete;
                }
              }

              return result;
            })
          : await transition(action);
      if (attempt !== generation) {
        return;
      }

      if (result.status === 'error') {
        toasts.error({
          id: 'database-feedback',
          title:
            result.error.code === 'BUSY'
              ? 'Another operation is in progress. Try again when it finishes.'
              : result.error.message,
        });
      } else if (result.status === 'success') {
        const destination = 'path' in result.value ? ` ${result.value.path}` : '';
        toasts.success({
          id: 'database-feedback',
          title: `${action === 'create' ? 'Database created.' : action === 'open' || action === 'retry' ? 'Database opened.' : action === 'restore' ? 'Database restored.' : action === 'backup' ? 'Backup saved.' : 'Customers exported.'}${destination}`,
        });
      }
    } catch {
      if (attempt === generation) {
        toasts.error({
          id: 'database-feedback',
          title:
            'The operation could not finish. Check the file and folder permissions, then try again.',
        });
      }
    } finally {
      if (attempt === generation) {
        publish({...state, pendingFile: null});
        flushSessionChange();
      }
    }
  }

  function dispose() {
    generation++;
    notifications.close('database-feedback');
    notifications.close('customer-refresh');

    stopState?.();
    stopProtection?.();
    stopState = stopProtection = null;
    protectionRequest = null;
    protection.dispose();
    pendingSessionChange = null;
    reconcilePromise = null;
    searches.clear();
    publish({
      ...state,
      phase: 'loading',
      pendingFile: null,
      refreshingCustomers: false,
      refreshError: null,
      pendingTransition: false,
      reconciling: false,
    });
  }

  async function start() {
    dispose();
    const attempt = generation;
    if (mode === 'unavailable') {
      publish({...state, phase: 'error'});
      return;
    }

    publish({
      ...state,
      phase: 'loading',
      error: null,
      pendingTransition: false,
      reconciling: false,
    });
    try {
      client ??=
        mode === 'live'
          ? getClient()
          : createPreviewClient(protection.confirmPreviewDiscard);
      stopState = client.database.onStateChanged(database => {
        if (attempt === generation) {
          acceptDatabase(database);
        }
      });
      stopProtection = client.drafts.registerProtection({
        prepare: async request => {
          if (protectionRequest) {
            throw new Error('Another preparation is active.');
          }

          protectionRequest = request;
          return protection.prepare(request);
        },
        resolve: resolution => {
          if (
            protectionRequest?.requestId !== resolution.requestId ||
            protectionRequest.documentId !== resolution.documentId
          ) {
            return;
          }

          protection.resolve(resolution);
          protectionRequest = null;
          if (resolution.outcome === 'committed') {
            flushSessionChange();
          } else {
            pendingSessionChange = null;
          }
        },
      });
      const result = await client.database.status();
      if (attempt !== generation) {
        return;
      }

      if (result.status !== 'success') {
        throw new Error(
          result.status === 'error' ? result.error.message : 'Startup was cancelled.'
        );
      }

      acceptDatabase(result.value);
      publish({...state, phase: 'ready', recoveryRequired: false});
    } catch {
      if (attempt === generation) {
        publish({
          ...state,
          phase: 'error',
          error: 'Could not connect to the application. Try again.',
        });
      }
    }
  }

  return {
    queryClient,
    protection,
    toasts,
    getState: () => state,
    getClient: () => client,
    isCurrentSession,
    captureSession(session: string) {
      const attempt = generation;
      return {
        session,
        isCurrent: () => attempt === generation && isCurrentSession(session),
      };
    },
    request,
    read<T extends {status: string}>(
      session: string,
      operation: (client: Client) => Promise<T>,
      scope: RequestScope = {}
    ) {
      const token = scope.navigationReadToken;
      const admitted =
        token && protection.isNavigationReadCurrent(token)
          ? () => protection.isNavigationReadCurrent(token)
          : undefined;
      return coordinatedRequest(session, operation, scope, admitted);
    },
    async commitImport(session: string, importId: string) {
      if (
        state.pendingFile ||
        state.refreshingCustomers ||
        state.pendingTransition ||
        state.reconciling ||
        protectionRequest ||
        protection.getState().frozen ||
        protection.getState().saving
      ) {
        return busy;
      }

      const attempt = generation;
      publish({...state, pendingFile: 'importSaving'});
      try {
        return await serialize(async () => {
          if (!client || !isCurrentSession(session) || state.recoveryRequired) {
            return unavailable;
          }

          const result = await client.imports.commit({session, importId});
          if (attempt !== generation || !isCurrentSession(session)) {
            return obsolete;
          }

          if (
            result.status === 'error' &&
            (result.error.code === 'STALE_SESSION' ||
              result.error.code === 'DATABASE_UNAVAILABLE')
          ) {
            await reconcile();
            if (attempt !== generation || !isCurrentSession(session)) {
              return obsolete;
            }
          }

          return result;
        });
      } finally {
        if (attempt === generation) {
          publish({...state, pendingFile: null});
          flushSessionChange();
        }
      }
    },
    async prepareImport() {
      const session = state.database?.session;
      if (
        !session ||
        state.pendingFile ||
        state.refreshingCustomers ||
        protection.getState().frozen ||
        protection.getState().saving
      ) {
        return busy;
      }

      const attempt = generation;
      publish({...state, pendingFile: 'import'});
      try {
        return await serialize(async () => {
          if (!client || !isCurrentSession(session)) {
            return unavailable;
          }

          const result = await client.imports.prepare({session});
          return attempt === generation && isCurrentSession(session) ? result : obsolete;
        });
      } finally {
        if (attempt === generation) {
          publish({...state, pendingFile: null});
          flushSessionChange();
        }
      }
    },
    fileAction,
    refreshCustomers,
    onCustomersRefreshed(listener: () => Promise<void>) {
      refreshListeners.add(listener);
      return () => {
        refreshListeners.delete(listener);
      };
    },
    reloadCustomer,
    transition,
    reconcile,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onSessionChanged(listener: (database: DatabaseState) => void) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    start,
    dispose,
  };
}

export type Application = ReturnType<typeof createApplication>;
