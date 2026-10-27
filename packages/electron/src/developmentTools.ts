import {setTimeout as delay} from 'node:timers/promises';

import {WebContentsView} from 'electron';
import {installExtension} from 'electron-devtools-installer';

let timeout: ReturnType<typeof setTimeout> | undefined;
let timedOut = false;
let readinessView: WebContentsView | undefined;
try {
  await Promise.race([
    (async () => {
      const extension = await installExtension('fmkadmapgofadopljbjfkapdkoienihi');
      if (timedOut) {
        return;
      }

      const view = new WebContentsView({
        webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false},
      });
      readinessView = view;
      await view.webContents.loadURL(`${extension.url}popups/disabled.html`);
      while (!timedOut && !view.webContents.isDestroyed()) {
        const ready = await view.webContents.executeJavaScript(`
          chrome.scripting.getRegisteredContentScripts().then(scripts =>
            scripts.some(script => script.id === '@react-devtools/hook' && script.world === 'MAIN') &&
            scripts.some(script => script.id === '@react-devtools/proxy')
          )
        `);
        if (ready) {
          return;
        }

        await delay(25);
      }
    })(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error('React Developer Tools setup timed out.'));
      }, 10_000);
    }),
  ]);
} catch (error) {
  console.warn('Could not load React Developer Tools.', error);
} finally {
  clearTimeout(timeout);
  if (readinessView && !readinessView.webContents.isDestroyed()) {
    readinessView.webContents.close();
  }
}
