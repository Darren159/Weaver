import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  hideWindow: () => ipcRenderer.send('hide-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  getConfig: (): Promise<{ bridgePort: number; backendUrl: string }> =>
    ipcRenderer.invoke('get-config'),
});
