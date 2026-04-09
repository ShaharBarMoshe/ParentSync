import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),

  getAppInfo: (): Promise<{
    version: string;
    userData: string;
    dbPath: string;
    isFirstRun: boolean;
  }> => ipcRenderer.invoke('get-app-info'),

  setFirstRunDone: (): Promise<void> => ipcRenderer.invoke('set-first-run-done'),

  showNotification: (title: string, body: string): Promise<void> =>
    ipcRenderer.invoke('show-notification', { title, body }),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('open-external', url),

  // WhatsApp QR events
  onWhatsAppQR: (callback: (qrDataUrl: string) => void): void => {
    ipcRenderer.on('whatsapp-qr', (_event, qrDataUrl: string) => callback(qrDataUrl));
  },

  onWhatsAppStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on('whatsapp-status', (_event, status: string) => callback(status));
  },

  // Sync trigger from tray
  onTriggerSync: (callback: () => void): void => {
    ipcRenderer.on('trigger-sync', () => callback());
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
});
