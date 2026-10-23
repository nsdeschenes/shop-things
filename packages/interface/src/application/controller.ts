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
import {Cause, Deferred, Effect, Exit, Scope, Semaphore} from 'effect';

import {CustomerRequestError, customerKeys} from './customers';
import {nativePromise, nextMicrotask, runRenderer} from './effects';
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

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: Record<string, unknown> & {requestScope?: RequestScope};
  }
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

interface RendererCoordinator {
  generation: number;
  scope: Scope.Closeable;
  semaphore: Semaphore.Semaphore;
  reconciliation: Deferred.Deferred<void, unknown> | null;
  searches: Map<string, object>;
}

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
  const coordinator: RendererCoordinator = {
    scope: Scope.makeUnsafe(),
    generation: 0,
    semaphore: Semaphore.makeUnsafe(1),
    reconciliation: null,
    searches: new Map<string, object>(),
  };
  let protectionRequest: DraftRequest | null = null;
  let pendingSessionChange: {
    database: DatabaseState;
    previousSession: string | null;
  } | null = null;
  let lastAvailableSession: string | null = null;
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

  function serialize<T, E>(operation: Effect.Effect<T, E>) {
    return coordinator.semaphore.withPermit(
      nextMicrotask.pipe(Effect.andThen(operation))
    );
  }

  function reconcile() {
    return Effect.suspend(() => {
      if (coordinator.reconciliation) {
        return Deferred.await(coordinator.reconciliation);
      }

      const pending = Deferred.makeUnsafe<void, unknown>();
      coordinator.reconciliation = pending;
      const attempt = coordinator.generation;
      publish({...state, reconciling: true, recoveryRequired: true});
      return Effect.gen(function* () {
        const result = yield* nativePromise(
          () => client?.database.status() ?? Promise.resolve(undefined)
        );
        if (attempt !== coordinator.generation) {
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
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (attempt === coordinator.generation) {
              coordinator.reconciliation = null;
              publish({...state, reconciling: false});
            }
          })
        ),
        Effect.onExit(exit => Effect.sync(() => Deferred.doneUnsafe(pending, exit)))
      );
    });
  }

  function coordinatedRequest<T extends {status: string}>(
    session: string,
    operation: (client: Client) => Promise<T>,
    scope: RequestScope = {},
    replacement?: () => boolean
  ) {
    return Effect.gen(function* () {
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

      const attempt = coordinator.generation;
      const token = {};
      if (scope.coalesceKey) {
        coordinator.searches.set(scope.coalesceKey, token);
      }

      function relevant() {
        return (
          attempt === coordinator.generation &&
          isCurrentSession(session) &&
          !scope.signal?.aborted &&
          (scope.isRelevant?.() ?? true) &&
          (!replacement || replacement()) &&
          (!scope.coalesceKey || coordinator.searches.get(scope.coalesceKey) === token)
        );
      }

      return yield* serialize(
        Effect.gen(function* () {
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

          const result = yield* nativePromise(() => operation(client!));
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
              yield* reconcile();
              if (!relevant()) {
                return obsolete;
              }
            }
          }

          return result;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (
                scope.coalesceKey &&
                coordinator.searches.get(scope.coalesceKey) === token
              ) {
                coordinator.searches.delete(scope.coalesceKey);
              }
            })
          )
        )
      );
    });
  }

  function request<T extends {status: string}>(
    session: string,
    operation: (client: Client) => Promise<T>,
    scope: RequestScope = {}
  ) {
    return runRenderer(coordinatedRequest(session, operation, scope));
  }

  function reloadCustomer(
    target: CustomerTarget,
    commit: (record: CustomerRecord) => void
  ) {
    return Effect.gen(function* () {
      if (!isCurrentSession(target.session) || !client || state.recoveryRequired) {
        throw new CustomerRequestError(unavailable.error);
      }

      if (state.pendingTransition || state.reconciling || protectionRequest) {
        throw new CustomerRequestError(busy.error);
      }

      const attempt = coordinator.generation;
      return yield* protection.effects.replaceDraft(
        replacement =>
          Effect.gen(function* () {
            const result = yield* coordinatedRequest(
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
          }),
        record => {
          if (attempt !== coordinator.generation || !isCurrentSession(target.session)) {
            throw new CancelledError({silent: true});
          }

          commit(record);
          queryClient.removeQueries({queryKey: ['customers', target.session, 'list']});
        }
      );
    });
  }

  function refreshCustomers() {
    return Effect.gen(function* () {
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

      const captured = {generation: coordinator.generation, session};
      function current() {
        return (
          captured.generation === coordinator.generation &&
          isCurrentSession(captured.session)
        );
      }

      publish({...state, refreshingCustomers: true, refreshError: null});
      notifications.close('customer-refresh');
      return yield* Effect.gen(function* () {
        const filter = {queryKey: customerKeys.session(session)};
        yield* nativePromise(() => queryClient.cancelQueries(filter));
        yield* nativePromise(() =>
          queryClient.invalidateQueries({...filter, refetchType: 'none'})
        );
        let failure: unknown;
        for (const query of queryClient
          .getQueryCache()
          .findAll({...filter, type: 'active'})) {
          if (!current()) {
            return;
          }

          yield* nativePromise(() =>
            queryClient.refetchQueries(
              {queryKey: query.queryKey, exact: true, type: 'active'},
              {throwOnError: true}
            )
          ).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                failure ??= Cause.squash(cause);
              })
            )
          );
        }

        if (!current()) {
          return;
        }

        for (const listener of refreshListeners) {
          if (!current()) {
            return;
          }

          yield* nativePromise(listener).pipe(
            Effect.catchCause(cause =>
              Effect.sync(() => {
                failure ??= Cause.squash(cause);
              })
            )
          );
        }

        if (failure) {
          throw failure;
        }
      }).pipe(
        Effect.catchCause(cause =>
          Effect.sync(() => {
            const failure = Cause.squash(cause);
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
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (captured.generation === coordinator.generation) {
              publish({...state, refreshingCustomers: false});
            }
          })
        )
      );
    });
  }

  function transition(action: 'create' | 'open' | 'restore' | 'retry') {
    return Effect.gen(function* () {
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

      const attempt = coordinator.generation;
      publish({...state, pendingTransition: true, error: null});
      return yield* serialize(
        Effect.gen(function* () {
          if (attempt !== coordinator.generation) {
            return obsolete;
          }

          const result = yield* nativePromise(() => client!.database[action]());
          if (attempt !== coordinator.generation) {
            return obsolete;
          }

          if (result.status === 'success') {
            acceptDatabase(result.value);
            publish({...state, recoveryRequired: false, error: null});
          }

          return result;
        })
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (attempt === coordinator.generation) {
              publish({...state, pendingTransition: false});
              flushSessionChange();
            }
          })
        )
      );
    });
  }

  function fileAction(
    action: 'create' | 'open' | 'retry' | 'restore' | 'backup' | 'export'
  ) {
    return Effect.gen(function* () {
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

      const attempt = coordinator.generation;
      notifications.close('database-feedback');

      publish({...state, pendingFile: action});
      return yield* Effect.gen(function* () {
        const session = state.database?.session;
        const result =
          action === 'backup' || action === 'export'
            ? yield* serialize(
                Effect.gen(function* () {
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
                      ? yield* nativePromise(() => client!.database.backup({session}))
                      : yield* nativePromise(() => client!.exports.csv({session}));
                  if (attempt !== coordinator.generation || !isCurrentSession(session)) {
                    return obsolete;
                  }

                  if (
                    result.status === 'error' &&
                    (result.error.code === 'STALE_SESSION' ||
                      result.error.code === 'DATABASE_UNAVAILABLE')
                  ) {
                    yield* reconcile();
                    if (
                      attempt !== coordinator.generation ||
                      !isCurrentSession(session)
                    ) {
                      return obsolete;
                    }
                  }

                  return result;
                })
              )
            : yield* transition(action);
        if (attempt !== coordinator.generation) {
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
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (attempt === coordinator.generation) {
              toasts.error({
                id: 'database-feedback',
                title:
                  'The operation could not finish. Check the file and folder permissions, then try again.',
              });
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (attempt === coordinator.generation) {
              publish({...state, pendingFile: null});
              flushSessionChange();
            }
          })
        )
      );
    });
  }

  function dispose() {
    return Effect.gen(function* () {
      coordinator.generation++;
      notifications.close('database-feedback');
      notifications.close('customer-refresh');

      yield* Scope.close(coordinator.scope, Exit.void);
      coordinator.scope = Scope.makeUnsafe();
      protectionRequest = null;
      protection.dispose();
      pendingSessionChange = null;
      coordinator.reconciliation = null;
      coordinator.searches.clear();
      publish({
        ...state,
        phase: 'loading',
        pendingFile: null,
        refreshingCustomers: false,
        refreshError: null,
        pendingTransition: false,
        reconciling: false,
      });
    });
  }

  function start() {
    return Effect.gen(function* () {
      yield* dispose();
      const attempt = coordinator.generation;
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
      return yield* Effect.gen(function* () {
        client ??=
          mode === 'live'
            ? getClient()
            : createPreviewClient(protection.confirmPreviewDiscard);
        const stopState = client.database.onStateChanged(database => {
          if (attempt === coordinator.generation) {
            acceptDatabase(database);
          }
        });
        yield* Scope.addFinalizer(coordinator.scope, Effect.sync(stopState));
        const stopProtection = client.drafts.registerProtection({
          prepare: request =>
            runRenderer(
              Effect.suspend(() => {
                if (protectionRequest) {
                  throw new Error('Another preparation is active.');
                }

                protectionRequest = request;
                return protection.effects.prepare(request);
              })
            ),
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
        yield* Scope.addFinalizer(coordinator.scope, Effect.sync(stopProtection));
        const result = yield* nativePromise(() => client!.database.status());
        if (attempt !== coordinator.generation) {
          return;
        }

        if (result.status !== 'success') {
          throw new Error(
            result.status === 'error' ? result.error.message : 'Startup was cancelled.'
          );
        }

        acceptDatabase(result.value);
        publish({...state, phase: 'ready', recoveryRequired: false});
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (attempt === coordinator.generation) {
              publish({
                ...state,
                phase: 'error',
                error: 'Could not connect to the application. Try again.',
              });
            }
          })
        )
      );
    });
  }

  return {
    queryClient,
    protection,
    toasts,
    getState: () => state,
    getClient: () => client,
    isCurrentSession,
    captureSession(session: string) {
      const attempt = coordinator.generation;
      return {
        session,
        isCurrent: () => attempt === coordinator.generation && isCurrentSession(session),
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
      return runRenderer(coordinatedRequest(session, operation, scope, admitted));
    },
    commitImport(session: string, importId: string) {
      return runRenderer(
        Effect.gen(function* () {
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

          const attempt = coordinator.generation;
          publish({...state, pendingFile: 'importSaving'});
          return yield* serialize(
            Effect.gen(function* () {
              if (!client || !isCurrentSession(session) || state.recoveryRequired) {
                return unavailable;
              }

              const result = yield* nativePromise(() =>
                client!.imports.commit({session, importId})
              );
              if (attempt !== coordinator.generation || !isCurrentSession(session)) {
                return obsolete;
              }

              if (
                result.status === 'error' &&
                (result.error.code === 'STALE_SESSION' ||
                  result.error.code === 'DATABASE_UNAVAILABLE')
              ) {
                yield* reconcile();
                if (attempt !== coordinator.generation || !isCurrentSession(session)) {
                  return obsolete;
                }
              }

              return result;
            })
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (attempt === coordinator.generation) {
                  publish({...state, pendingFile: null});
                  flushSessionChange();
                }
              })
            )
          );
        })
      );
    },
    prepareImport() {
      return runRenderer(
        Effect.gen(function* () {
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

          const attempt = coordinator.generation;
          publish({...state, pendingFile: 'import'});
          return yield* serialize(
            Effect.gen(function* () {
              if (!client || !isCurrentSession(session)) {
                return unavailable;
              }

              const result = yield* nativePromise(() =>
                client!.imports.prepare({session})
              );
              return attempt === coordinator.generation && isCurrentSession(session)
                ? result
                : obsolete;
            })
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (attempt === coordinator.generation) {
                  publish({...state, pendingFile: null});
                  flushSessionChange();
                }
              })
            )
          );
        })
      );
    },
    fileAction: (action: Parameters<typeof fileAction>[0]) =>
      runRenderer(fileAction(action)),
    refreshCustomers: () => runRenderer(refreshCustomers()),
    onCustomersRefreshed(listener: () => Promise<void>) {
      refreshListeners.add(listener);
      return () => {
        refreshListeners.delete(listener);
      };
    },
    reloadCustomer: (target: CustomerTarget, commit: (record: CustomerRecord) => void) =>
      runRenderer(reloadCustomer(target, commit)),
    transition: (action: Parameters<typeof transition>[0]) =>
      runRenderer(transition(action)),
    reconcile: () => runRenderer(reconcile()),
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
    start: () => runRenderer(start()),
    dispose: () => Effect.runSync(dispose()),
  };
}

export type Application = ReturnType<typeof createApplication>;
