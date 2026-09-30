/* oxlint-disable import/no-named-export -- Trusted renderer document policy. */
import {randomUUID} from 'node:crypto';

import type {ApprovedDocument} from './ipc.js';

type DocumentContents = ApprovedDocument['webContents'];

export interface DocumentWebContents extends DocumentContents {
  mainFrame: {url: string};
  on(
    event: 'did-start-navigation',
    callback: (
      event: unknown,
      url: string,
      inPlace: boolean,
      isMainFrame: boolean
    ) => void
  ): unknown;
  on(event: 'dom-ready' | 'destroyed' | 'did-navigate', callback: () => void): unknown;
  removeListener(
    event: string,
    callback:
      | ((event: unknown, url: string, inPlace: boolean, isMainFrame: boolean) => void)
      | (() => void)
  ): unknown;
}

export function isTrustedRendererUrl(candidate: string, approvedUrl: string): boolean {
  try {
    const actual = new URL(candidate);
    const approved = new URL(approvedUrl);
    actual.hash = '';
    approved.hash = '';
    // The preview switch is intentional routing state, never a trust credential.
    if (actual.searchParams.get('preview') === 'true') {
      actual.searchParams.delete('preview');
    }

    if (approved.searchParams.get('preview') === 'true') {
      approved.searchParams.delete('preview');
    }

    return actual.href === approved.href;
  } catch {
    return false;
  }
}

export function trackAuthorizedDocument(
  webContents: DocumentWebContents,
  approvedUrl: string
) {
  let document: ApprovedDocument | null = null;
  const listeners = new Set<() => void>();
  function invalidate() {
    document = null;
    for (const callback of listeners) {
      callback();
    }
  }

  function navigating(
    _event: unknown,
    url: string,
    inPlace: boolean,
    isMainFrame: boolean
  ) {
    if (isMainFrame && !inPlace && isTrustedRendererUrl(url, approvedUrl)) {
      invalidate();
    } else if (isMainFrame && document && isTrustedRendererUrl(url, approvedUrl)) {
      document.url = url;
    }
  }

  function ready() {
    invalidate();
    if (
      !webContents.isDestroyed() &&
      isTrustedRendererUrl(webContents.mainFrame.url, approvedUrl)
    ) {
      document = {
        documentId: randomUUID(),
        url: webContents.mainFrame.url,
        frame: webContents.mainFrame,
        webContents,
      };
    }
  }

  // Unapproved attempts are blocked by the navigation policy and must retain the
  // running document's participant. A programmatically replaced document is revoked
  // at navigation commit, before the new page's scripts can use its bridge.
  webContents.on('did-start-navigation', navigating);
  webContents.on('did-navigate', invalidate);
  webContents.on('dom-ready', ready);
  webContents.on('destroyed', invalidate);

  return {
    currentDocument: () => document,
    onDocumentChanged(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    dispose() {
      invalidate();
      listeners.clear();
      webContents.removeListener('did-start-navigation', navigating);
      webContents.removeListener('did-navigate', invalidate);
      webContents.removeListener('dom-ready', ready);
      webContents.removeListener('destroyed', invalidate);
    },
  };
}
