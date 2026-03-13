export {};

declare global {
  interface Window {
    electronAPI: {
      hideWindow: () => void;
      getConfig: () => Promise<{ bridgePort: number; backendUrl: string }>;
    };
  }
}
