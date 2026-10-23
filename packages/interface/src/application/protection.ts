import type {Client, DraftRequest, DraftResolution} from '@shop-things/contract';
import {Cause, Deferred, Effect, Exit} from 'effect';

import {nativePromise, nextMicrotask, runRenderer} from './effects';

export type DraftValues = Readonly<Record<string, string | boolean | number>>;
export interface DraftEditor {
  values(): DraftValues;
  baseline(): DraftValues;
  reset(): void;
}

export function navigationTarget(pathname: string, search: object): string {
  return (
    pathname +
    JSON.stringify(
      Object.fromEntries(
        Object.entries(search).sort(([first], [second]) => first.localeCompare(second))
      )
    )
  );
}

export function sameDraftValues(first: DraftValues, second: DraftValues): boolean {
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(second).length &&
    keys.every(key => first[key] === second[key])
  );
}

type PendingAction = {editor: DraftEditor | null} & (
  | {kind: 'lifecycle'; request: DraftRequest}
  | {
      kind: 'navigation';
      target: string;
      destination?: string;
      approved: boolean;
      readToken: string;
    }
  | {kind: 'replacement'}
);

export function createDraftProtection(getClient: () => Client | null) {
  let editor: DraftEditor | null = null;
  let pendingAction: PendingAction | null = null;
  let previewPrompt: Deferred.Deferred<boolean> | null = null;
  let saving: Deferred.Deferred<unknown, unknown> | null = null;
  let state: {
    registeredEditor: DraftEditor | null;
    confirmingDiscard: boolean;
    frozen: boolean;
    saving: boolean;
    dirty: boolean;
    error: string | null;
  } = {
    registeredEditor: editor,
    confirmingDiscard: false,
    frozen: false,
    saving: false,
    dirty: false,
    error: null,
  };
  const listeners = new Set<() => void>();

  function readDirty() {
    return editor !== null && !sameDraftValues(editor.values(), editor.baseline());
  }

  function isDirty() {
    try {
      return readDirty();
    } catch {
      return true;
    }
  }

  function publish(error: string | null = state.error) {
    state = {
      registeredEditor: editor,
      confirmingDiscard: previewPrompt !== null,
      frozen: pendingAction !== null,
      saving: saving !== null,
      dirty: isDirty(),
      error,
    };
    for (const listener of listeners) {
      listener();
    }
  }

  function registerEditor(next: DraftEditor) {
    // React releases the old editor before mounting the destination; router resolution
    // can follow that mount. Keep the approved route frozen until its matching commit.
    if (
      editor ||
      (pendingAction && !(pendingAction.kind === 'navigation' && pendingAction.approved))
    ) {
      throw new Error('Another editor or protected transition is active.');
    }

    editor = next;
    publish(null);
    return () => {
      if (editor === next) {
        editor = null;
        publish();
      }
    };
  }

  function save<T>(work: () => Promise<T>): Promise<T> {
    return runRenderer(
      Effect.gen(function* () {
        if (state.frozen || saving) {
          return yield* Effect.fail(
            new Error('Wait for the current operation to finish.')
          );
        }

        const pending = Deferred.makeUnsafe<unknown, unknown>();
        saving = pending;
        publish(null);
        return yield* nextMicrotask.pipe(
          Effect.andThen(nativePromise(work)),
          Effect.onExit(exit =>
            Effect.sync(() => {
              Deferred.doneUnsafe(pending, exit);
              if (saving === pending) {
                saving = null;
                publish();
              }
            })
          )
        );
      })
    );
  }

  function beginAction(action: PendingAction) {
    if (pendingAction) {
      throw new Error('Another protected transition is active.');
    }

    pendingAction = action;
    publish(null);
  }

  function isCurrentAction(action: PendingAction) {
    return pendingAction === action;
  }

  function finishAction(action: PendingAction, discard = false) {
    if (!isCurrentAction(action)) {
      return;
    }

    pendingAction = null;
    if (discard) {
      action.editor?.reset();
    }

    publish(null);
  }

  function confirmDiscard() {
    return Effect.gen(function* () {
      if (!readDirty()) {
        yield* nextMicrotask;
        return true;
      }

      const result = yield* nativePromise(
        () => getClient()?.drafts.confirmDiscard() ?? Promise.resolve(undefined)
      );
      if (result?.status === 'cancelled') {
        return false;
      }

      if (result?.status !== 'success') {
        return yield* Effect.fail(
          new Error(
            result?.status === 'error'
              ? result.error.message
              : 'Draft protection is unavailable.'
          )
        );
      }

      return true;
    });
  }

  function prepare(request: DraftRequest) {
    return Effect.gen(function* () {
      const pending: PendingAction = {kind: 'lifecycle', request, editor};
      beginAction(pending);
      if (saving) {
        yield* Deferred.await(saving).pipe(Effect.catchCause(() => Effect.void));
      } else {
        yield* nextMicrotask;
      }

      if (!isCurrentAction(pending)) {
        return yield* Effect.fail(new Error('Draft preparation was aborted.'));
      }

      return {...request, hasUnsavedDraft: readDirty()};
    });
  }

  function resolve(resolution: DraftResolution): boolean {
    const pending = pendingAction;
    if (
      pending?.kind !== 'lifecycle' ||
      pending.request.requestId !== resolution.requestId ||
      pending.request.documentId !== resolution.documentId
    ) {
      return false;
    }

    finishAction(pending, resolution.outcome === 'committed');
    return true;
  }

  function blockNavigation(target: string) {
    return Effect.gen(function* () {
      if (pendingAction || saving) {
        return true;
      }

      if (!isDirty()) {
        return false;
      }

      const pending: PendingAction = {
        kind: 'navigation',
        target,
        editor,
        approved: false,
        readToken: crypto.randomUUID(),
      };
      beginAction(pending);
      return yield* Effect.gen(function* () {
        const approved = yield* confirmDiscard();
        if (!isCurrentAction(pending)) {
          return true;
        }

        if (approved) {
          pending.approved = true;
          return false;
        }

        finishAction(pending);
        return true;
      }).pipe(
        Effect.catchCause(cause =>
          Effect.sync(() => {
            if (isCurrentAction(pending)) {
              finishAction(pending);
              const failure = Cause.squash(cause);
              publish(
                failure instanceof Error
                  ? failure.message
                  : 'Could not confirm navigation. Your edits are retained. Try again.'
              );
            }

            return true;
          })
        )
      );
    });
  }

  function navigationResolved(target: string, committed = true) {
    const pending = pendingAction;
    if (
      pending?.kind !== 'navigation' ||
      !pending.approved ||
      (pending.target !== target && pending.destination !== target)
    ) {
      return;
    }

    finishAction(pending, committed);
    if (!committed) {
      publish('Navigation did not finish. Your edits are retained. Try again.');
    }
  }

  function answerDiscard(approved: boolean) {
    const answer = previewPrompt;
    previewPrompt = null;
    if (answer) {
      Deferred.doneUnsafe(answer, Exit.succeed(approved));
    }

    publish();
  }

  function confirmPreviewDiscard(): Promise<boolean> {
    return runRenderer(
      Effect.suspend(() => {
        if (previewPrompt) {
          return Effect.succeed(false);
        }

        previewPrompt = Deferred.makeUnsafe<boolean>();
        publish();
        return Deferred.await(previewPrompt);
      })
    );
  }

  function replaceDraft<T>(
    load: (isCurrent: () => boolean) => Effect.Effect<T, unknown>,
    commit: (value: T) => void
  ) {
    return Effect.gen(function* () {
      if (state.frozen || saving) {
        return yield* Effect.fail(new Error('Wait for the current operation to finish.'));
      }

      const pending: PendingAction = {kind: 'replacement', editor};
      beginAction(pending);
      function isCurrent() {
        return isCurrentAction(pending) && editor === pending.editor;
      }

      return yield* Effect.gen(function* () {
        if (!(yield* confirmDiscard()) || !isCurrent()) {
          return false;
        }

        const value = yield* load(isCurrent);
        if (!isCurrent()) {
          return false;
        }

        commit(value);
        return true;
      }).pipe(Effect.ensuring(Effect.sync(() => finishAction(pending))));
    });
  }

  function dispose() {
    answerDiscard(false);
    pendingAction = null;
    publish(null);
  }

  return {
    registerEditor,
    effects: {prepare, replaceDraft},
    replaceDraft<T>(
      load: (isCurrent: () => boolean) => Promise<T>,
      commit: (value: T) => void
    ) {
      return runRenderer(
        replaceDraft(current => nativePromise(() => load(current)), commit)
      );
    },
    save,
    answerDiscard,
    confirmPreviewDiscard,
    navigateAfterSave(navigate: () => void) {
      if (saving || pendingAction || isDirty()) {
        return false;
      }

      navigate();
      return true;
    },
    prepare: (request: DraftRequest) => runRenderer(prepare(request)),
    resolve,
    blockNavigation: (target: string) => runRenderer(blockNavigation(target)),
    navigationResolved,
    navigationLoaded(target: string, destination: string) {
      if (
        pendingAction?.kind === 'navigation' &&
        pendingAction.approved &&
        pendingAction.target === target
      ) {
        pendingAction.destination = destination;
      }
    },
    navigationReadToken(target: string) {
      const pending = pendingAction;
      return pending?.kind === 'navigation' &&
        pending.approved &&
        pending.target === target
        ? pending.readToken
        : undefined;
    },
    isNavigationReadCurrent(token: string) {
      return (
        pendingAction?.kind === 'navigation' &&
        pendingAction.approved &&
        pendingAction.readToken === token
      );
    },
    dispose,
    isDirty,
    changed: () => publish(null),
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type DraftProtectionOwner = ReturnType<typeof createDraftProtection>;
