import {readFileSync, realpathSync} from 'node:fs';

import {app, dialog} from 'electron';
const expected = realpathSync(process.env.WATCHER_DATA);
if (app.getPath('userData') !== expected) {
  app.setPath('userData', expected);
  app.exit(2);
  throw new Error('Isolation mismatch');
}

console.log(
  'WATCHER_ENTRY ' +
    JSON.stringify({
      pid: process.pid,
      connected: process.connected,
      data: app.getPath('userData'),
    })
);
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  const controls = JSON.parse(readFileSync(process.env.WATCHER_CONTROL, 'utf8'));
  const discard = options.message === 'Discard unsaved changes?' && controls.discard;
  console.log(
    'WATCHER_DIALOG ' +
      JSON.stringify({pid: process.pid, message: options.message, discard})
  );
  return {response: discard ? 1 : 0};
};

await import(process.env.WATCHER_MAIN);
