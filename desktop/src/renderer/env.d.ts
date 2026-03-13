export {};

declare global {
  interface Window {
    electronAPI: {
      hideWindow: () => void;
      minimizeWindow: () => void;
      getConfig: () => Promise<{ bridgePort: number; backendUrl: string }>;
    };
  }
}
