import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

import {_electron} from '@playwright/test';

const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');
const entry = fileURLToPath(new URL('./electron-entry.mjs', import.meta.url));

// Scenarios retain their own data and assertions; only built-entry isolation is shared.
export default function launchElectron(
  directory: string,
  env: Record<string, string> = {}
) {
  return _electron.launch({
    executablePath,
    args: [entry],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      VITE_DEV_SERVER_URL: '',
      ...env,
    },
  });
}
