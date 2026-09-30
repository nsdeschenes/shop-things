import {contextBridge, ipcRenderer} from 'electron';

import {createPreloadBridge} from './preloadBridge.js';

contextBridge.exposeInMainWorld('shopThings', createPreloadBridge(ipcRenderer));
