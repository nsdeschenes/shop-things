import { contextBridge, ipcRenderer } from "electron";
import { createPreloadBridge } from "./preload-bridge.js";
contextBridge.exposeInMainWorld("shopThings", createPreloadBridge(ipcRenderer));
