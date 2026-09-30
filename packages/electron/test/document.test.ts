import {EventEmitter} from 'node:events';

import {expect, test} from 'vitest';

import {isTrustedRendererUrl, trackAuthorizedDocument} from '../src/document.js';
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

test('allows only routing state around the configured renderer resource', () => {
  expect(
    isTrustedRendererUrl(
      'http://127.0.0.1:5173/?preview=true#/customers/2',
      'http://127.0.0.1:5173/'
    )
  ).toBe(true);
  for (const candidate of [
    'http://127.0.0.1:5174/',
    'http://localhost:5173/',
    'http://127.0.0.1:5173/other',
    'http://127.0.0.1:5173/?other=true',
    'http://127.0.0.1:5173/?preview=false',
  ]) {
    expect(isTrustedRendererUrl(candidate, 'http://127.0.0.1:5173/')).toBe(false);
  }

  expect(
    isTrustedRendererUrl(
      'file:///app/renderer/index.html#/customers/2',
      'file:///app/renderer/index.html'
    )
  ).toBe(true);
  expect(
    isTrustedRendererUrl('file:///other/index.html', 'file:///app/renderer/index.html')
  ).toBe(false);
});

test('same-document hash routing retains authorization and document identity', () => {
  const contents = new Contents();
  const tracked = trackAuthorizedDocument(contents, contents.mainFrame.url);
  contents.emit('dom-ready');
  const document = tracked.currentDocument();
  contents.mainFrame.url += '#/customers/2';
  contents.emit('did-start-navigation', {}, contents.mainFrame.url, true, true);
  expect(tracked.currentDocument()).toBe(document);
  expect(document?.url).toBe(contents.mainFrame.url);
  tracked.dispose();
});
