import {EventEmitter} from 'node:events';

import {expect, test} from 'vitest';

import {trackAuthorizedDocument} from '../src/document.js';
class Contents extends EventEmitter {
  mainFrame = {url: 'file:///app/renderer/index.html'};
  isDestroyed() {
    return false;
  }
  send() {}
}
test('document authorization changes on same-URL navigation and rejects unapproved documents', () => {
  const contents = new Contents();
  const tracked = trackAuthorizedDocument(contents, contents.mainFrame.url);
  let invalidations = 0;
  const stop = tracked.onDocumentChanged(() => {
    invalidations++;
  });
  expect(tracked.currentDocument()).toBeNull();
  contents.emit('dom-ready');
  const first = tracked.currentDocument();
  expect(first).not.toBeNull();
  contents.emit('did-start-navigation', {}, contents.mainFrame.url, false, false);
  expect(tracked.currentDocument()).toBe(first);
  contents.emit('did-start-navigation', {}, contents.mainFrame.url, false, true);
  expect(tracked.currentDocument()).toBeNull();
  contents.emit('dom-ready');
  const next = tracked.currentDocument();
  expect(next?.documentId).not.toBe(first?.documentId);
  contents.mainFrame.url = 'file:///arbitrary/index.html';
  contents.emit('dom-ready');
  expect(tracked.currentDocument()).toBeNull();
  expect(invalidations).toBe(4);
  stop();
  tracked.dispose();
  expect(contents.listenerCount('dom-ready')).toBe(0);
  expect(contents.listenerCount('did-start-navigation')).toBe(0);
  expect(contents.listenerCount('destroyed')).toBe(0);
});
