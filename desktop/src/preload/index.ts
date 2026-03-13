import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  hideWindow: () => ipcRenderer.send('hide-window'),
  getConfig: (): Promise<{ bridgePort: number; backendUrl: string }> =>
    ipcRenderer.invoke('get-config'),
});
