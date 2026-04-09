interface ElectronAPI {
  getBackendUrl(): Promise<string>;
  getAppInfo(): Promise<{
    version: string;
    userData: string;
    dbPath: string;
    isFirstRun: boolean;
  }>;
  setFirstRunDone(): Promise<void>;
  showNotification(title: string, body: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onWhatsAppQR(callback: (qrDataUrl: string) => void): void;
  onWhatsAppStatus(callback: (status: string) => void): void;
  onTriggerSync(callback: () => void): void;
  removeAllListeners(channel: string): void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
