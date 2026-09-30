import {fileURLToPath} from 'node:url';

import {app, ipcMain, session} from 'electron';

// Test-only observation preserves real Electron events, senderFrame and production handlers.
const record = {incoming: [], outgoing: []};
globalThis.acceptanceBoundary = record;
function incoming(kind, channel, event, args) {
  const message = {
    kind,
    channel,
    wc: event.sender.id,
    main: event.senderFrame === event.sender.mainFrame,
    frameUrl: event.senderFrame?.url ?? null,
    payload: args[0],
  };
  record.incoming.push(message);
  return message;
}

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handle(channel, async (event, ...args) => {
    const message = incoming('invoke', channel, event, args);
    const result = await listener(event, ...args);
    message.result = result;
    return result;
  });
const on = ipcMain.on.bind(ipcMain);
const remove = ipcMain.removeListener.bind(ipcMain);
const wrapped = new Map();
ipcMain.on = (channel, listener) => {
  function observe(event, ...args) {
    if (channel.startsWith('shop-things:')) {
      incoming('send', channel, event, args);
    }

    return listener(event, ...args);
  }

  if (!wrapped.has(channel)) {
    wrapped.set(channel, new WeakMap());
  }

  wrapped.get(channel).set(listener, observe);
  return on(channel, observe);
};

ipcMain.removeListener = (channel, listener) => {
  const observe = wrapped.get(channel)?.get(listener);
  if (observe) {
    wrapped.get(channel).delete(listener);
  }

  return remove(channel, observe ?? listener);
};

const observed = new Set([
  'shop-things:state-changed',
  'shop-things:draft-prepare',
  'shop-things:draft-resolve',
]);
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    if (observed.has(channel)) {
      record.outgoing.push({wc: contents.id, channel, payload: args[0]});
    }

    return send(channel, ...args);
  };
});
void app.whenReady().then(() => {
  session.defaultSession.registerPreloadScript({
    type: 'frame',
    filePath: fileURLToPath(new URL('./boundary-preload.cjs', import.meta.url)),
  });
});

await import('./boundary-frame.mjs');
