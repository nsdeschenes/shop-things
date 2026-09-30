/* oxlint-disable import/no-named-export -- Application bootstrap and shared state owner. */
import type {Client, DatabaseState} from '@shop-things/contract';
import {applyNewerDatabaseState, getClient} from '@shop-things/contract/client';

import createPreviewClient from './preview';

export interface ApplicationState {
  mode: 'live' | 'preview' | 'unavailable';
  phase: 'loading' | 'ready' | 'error';
  database: DatabaseState | null;
  error: string | null;
}

export function createApplication(
  url: string,
  attached = Reflect.has(window, 'shopThings')
) {
  const mode = attached
    ? 'live'
    : new URL(url).searchParams.get('preview') === 'true'
      ? 'preview'
      : 'unavailable';
  let client: Client | null = null;
  let state: ApplicationState = {mode, phase: 'loading', database: null, error: null};
  let generation = 0;
  let stopState: (() => void) | null = null;
  let stopProtection: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function publish(next: ApplicationState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function dispose() {
    generation++;
    stopState?.();
    stopProtection?.();
    stopState = stopProtection = null;
  }

  async function start() {
    dispose();
    const attempt = generation;
    if (mode === 'unavailable') {
      publish({...state, phase: 'error'});
      return;
    }

    publish({...state, phase: 'loading', error: null});
    try {
      client ??= mode === 'live' ? getClient() : createPreviewClient();
      stopState = client.database.onStateChanged(database => {
        if (attempt === generation) {
          publish({
            ...state,
            database: applyNewerDatabaseState(state.database, database),
          });
        }
      });
      // Editors are unavailable in this stage. Replace this participant before enabling them.
      stopProtection = client.drafts.registerProtection({
        prepare: async request => ({...request, hasUnsavedDraft: false}),
        resolve: () => {},
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

      publish({
        ...state,
        phase: 'ready',
        database: applyNewerDatabaseState(state.database, result.value),
      });
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
    getState: () => state,
    getClient: () => client,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    dispose,
  };
}

export type Application = ReturnType<typeof createApplication>;
