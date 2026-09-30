/* oxlint-disable import/no-named-export -- Shared document-owned draft protection. */
import type {Client, DraftRequest, DraftResolution} from '@shop-things/contract';

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
  let previewPrompt: ((approved: boolean) => void) | null = null;
  let saving: Promise<unknown> | null = null;
  let state = {
    confirmingDiscard: false,
    frozen: false,
    saving: false,
    dirty: false,
    error: null as string | null,
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

  async function save<T>(work: () => Promise<T>): Promise<T> {
    if (state.frozen || saving) {
      throw new Error('Wait for the current operation to finish.');
    }

    const pending = Promise.resolve().then(work);
    saving = pending;
    publish(null);
    try {
      return await pending;
    } finally {
      if (saving === pending) {
        saving = null;
        publish();
      }
    }
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

  async function confirmDiscard(): Promise<boolean> {
    if (!readDirty()) {
      return true;
    }

    const result = await getClient()?.drafts.confirmDiscard();
    if (result?.status === 'cancelled') {
      return false;
    }

    if (result?.status !== 'success') {
      throw new Error(
        result?.status === 'error'
          ? result.error.message
          : 'Draft protection is unavailable.'
      );
    }

    return true;
  }

  async function prepare(request: DraftRequest) {
    const pending: PendingAction = {kind: 'lifecycle', request, editor};
    beginAction(pending);
    try {
      await saving;
    } catch {
      /* Failed Save leaves its entered values intact. */
    }

    if (!isCurrentAction(pending)) {
      throw new Error('Draft preparation was aborted.');
    }

    return {...request, hasUnsavedDraft: readDirty()};
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

  async function blockNavigation(target: string): Promise<boolean> {
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
    try {
      const approved = await confirmDiscard();
      if (!isCurrentAction(pending)) {
        return true;
      }

      if (approved) {
        pending.approved = true;
        return false;
      }

      finishAction(pending);
    } catch (error) {
      if (isCurrentAction(pending)) {
        finishAction(pending);
        publish(
          error instanceof Error
            ? error.message
            : 'Could not confirm navigation. Your edits are retained. Try again.'
        );
      }
    }

    return true;
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
    answer?.(approved);
    publish();
  }

  function confirmPreviewDiscard(): Promise<boolean> {
    if (previewPrompt) {
      return Promise.resolve(false);
    }

    return new Promise(resolve => {
      previewPrompt = resolve;
      publish();
    });
  }

  async function replaceDraft<T>(
    load: (isCurrent: () => boolean) => Promise<T>,
    commit: (value: T) => void
  ): Promise<boolean> {
    if (state.frozen || saving) {
      throw new Error('Wait for the current operation to finish.');
    }

    const pending: PendingAction = {kind: 'replacement', editor};
    beginAction(pending);
    function isCurrent() {
      return isCurrentAction(pending) && editor === pending.editor;
    }

    try {
      if (!(await confirmDiscard()) || !isCurrent()) {
        return false;
      }

      const value = await load(isCurrent);
      if (!isCurrent()) {
        return false;
      }

      commit(value);
      return true;
    } finally {
      finishAction(pending);
    }
  }

  function dispose() {
    answerDiscard(false);
    pendingAction = null;
    publish(null);
  }

  return {
    registerEditor,
    replaceDraft,
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
    prepare,
    resolve,
    blockNavigation,
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
