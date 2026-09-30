/* oxlint-disable import/no-named-export -- Future renderer integration document policy; inactive in main. */
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
  on(event: 'dom-ready' | 'destroyed', callback: () => void): unknown;
  removeListener(
    event: string,
    callback:
      | ((event: unknown, url: string, inPlace: boolean, isMainFrame: boolean) => void)
      | (() => void)
  ): unknown;
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
    _url: string,
    _inPlace: boolean,
    isMainFrame: boolean
  ) {
    if (isMainFrame) {
      invalidate();
    }
  }

  function ready() {
    invalidate();
    if (!webContents.isDestroyed() && webContents.mainFrame.url === approvedUrl) {
      document = {
        documentId: randomUUID(),
        url: approvedUrl,
        frame: webContents.mainFrame,
        webContents,
      };
    }
  }

  webContents.on('did-start-navigation', navigating);
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
      webContents.removeListener('dom-ready', ready);
      webContents.removeListener('destroyed', invalidate);
    },
  };
}
