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

export function createDraftProtection(getClient: () => Client | null) {
  let editor: DraftEditor | null = null;
  let preparing: {request: DraftRequest; editor: DraftEditor | null} | null = null;
  let route: {target: string; editor: DraftEditor | null; approved: boolean} | null =
    null;
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
      frozen: preparing !== null || route !== null,
      saving: saving !== null,
      dirty: isDirty(),
      error,
    };
    for (const listener of listeners) {
      listener();
    }
  }

  function registerEditor(next: DraftEditor) {
    if (editor || preparing || route) {
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

  async function prepare(request: DraftRequest) {
    if (preparing || route) {
      throw new Error('Another protected transition is active.');
    }

    const pending = {request, editor};
    preparing = pending;
    publish(null);
    try {
      await saving;
    } catch {
      /* Failed Save leaves its entered values intact. */
    }

    if (preparing !== pending) {
      throw new Error('Draft preparation was aborted.');
    }

    return {...request, hasUnsavedDraft: readDirty()};
  }

  function resolve(resolution: DraftResolution): boolean {
    if (
      !preparing ||
      preparing.request.requestId !== resolution.requestId ||
      preparing.request.documentId !== resolution.documentId
    ) {
      return false;
    }

    const previous = preparing;
    preparing = null;
    if (resolution.outcome === 'committed') {
      previous.editor?.reset();
    }

    publish(null);
    return true;
  }

  async function blockNavigation(target: string): Promise<boolean> {
    if (preparing || route || saving) {
      return true;
    }

    if (!isDirty()) {
      return false;
    }

    const pending = {target, editor, approved: false};
    route = pending;
    publish(null);
    try {
      const result = await getClient()?.drafts.confirmDiscard();
      if (route !== pending) {
        return true;
      }

      if (result?.status === 'success') {
        pending.approved = true;
        return false;
      }

      route = null;
      publish(result?.status === 'error' ? result.error.message : null);
      return true;
    } catch {
      if (route === pending) {
        route = null;
        publish('Could not confirm navigation. Your edits are retained. Try again.');
      }

      return true;
    }
  }

  function navigationResolved(target: string, committed = true) {
    if (!route || !route.approved || route.target !== target) {
      return;
    }

    const previous = route;
    route = null;
    if (committed) {
      previous.editor?.reset();
    }

    publish(
      committed ? null : 'Navigation did not finish. Your edits are retained. Try again.'
    );
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

  function dispose() {
    answerDiscard(false);
    preparing = null;
    route = null;
    publish(null);
  }

  return {
    registerEditor,
    save,
    answerDiscard,
    confirmPreviewDiscard,
    navigateAfterSave(navigate: () => void) {
      if (saving || preparing || route || isDirty()) {
        return false;
      }

      navigate();
      return true;
    },
    prepare,
    resolve,
    blockNavigation,
    navigationResolved,
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
