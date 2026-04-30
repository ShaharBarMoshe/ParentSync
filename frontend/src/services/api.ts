import axios from 'axios';

// In Electron, get the backend URL dynamically via IPC
// In browser, use the env variable or default
function getBaseURL(): string {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    // Will be overridden once the async call resolves — see initElectronApi()
    return 'http://127.0.0.1:41932/api';
  }
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:41932/api';
}

const api = axios.create({
  baseURL: getBaseURL(),
});

// Call this once at app startup when running in Electron
export async function initElectronApi(): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    const url = await (window as any).electronAPI.getBackendUrl();
    api.defaults.baseURL = url;
  }
}

export interface Setting {
  id: string;
  key: string;
  value: string;
  updatedAt: string;
}

export const settingsApi = {
  getAll: () => api.get<Setting[]>('/settings').then((r) => r.data),
  getByKey: (key: string) =>
    api.get<Setting>(`/settings/${key}`).then((r) => r.data),
  create: (key: string, value: string) =>
    api.post<Setting>('/settings', { key, value }).then((r) => r.data),
  update: (key: string, value: string) =>
    api.put<Setting>(`/settings/${key}`, { value }).then((r) => r.data),
  delete: (key: string) => api.delete(`/settings/${key}`),
};

export interface AccountStatus {
  authenticated: boolean;
  email?: string;
}

export interface AuthStatus {
  gmail: AccountStatus;
  calendar: AccountStatus;
}

export type AuthPurpose = 'gmail' | 'calendar';

export const authApi = {
  getStatus: () =>
    api.get<AuthStatus>('/auth/google/status').then((r) => r.data),
  getConnectUrl: (purpose: AuthPurpose) =>
    `${api.defaults.baseURL}/auth/google/${purpose}`,
  disconnect: (purpose: AuthPurpose) =>
    api.delete(`/auth/google/${purpose}`),
};

// Children API

export interface Child {
  id: string;
  name: string;
  channelNames: string | null;
  teacherEmails: string | null;
  calendarColor: string | null;
  lastScanAt: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export const childrenApi = {
  getAll: () => api.get<Child[]>('/children').then((r) => r.data),
  create: (data: { name: string; channelNames?: string; teacherEmails?: string; calendarColor?: string }) =>
    api.post<Child>('/children', data).then((r) => r.data),
  update: (id: string, data: Partial<{ name: string; channelNames: string; teacherEmails: string; calendarColor: string }>) =>
    api.put<Child>(`/children/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/children/${id}`),
  reorder: (ids: string[]) => api.put<Child[]>('/children/reorder', { ids }).then((r) => r.data),
};

// Messages API

export interface Message {
  id: string;
  source: 'whatsapp' | 'email';
  content: string;
  timestamp: string;
  channel: string;
  sender: string | null;
  parsed: boolean;
  createdAt: string;
}

export const messagesApi = {
  getAll: (params?: { source?: string; unparsed?: boolean; limit?: number }) =>
    api.get<Message[]>('/messages', { params: { limit: 200, ...params } }).then((r) => r.data),
  getById: (id: string) =>
    api.get<Message>(`/messages/${id}`).then((r) => r.data),
};

// Calendar Events API

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  date: string;
  time: string | null;
  location: string | null;
  source: 'whatsapp' | 'email' | null;
  sourceId: string | null;
  googleEventId: string | null;
  syncType: 'event' | 'task';
  syncedToGoogle: boolean;
  createdAt: string;
  updatedAt: string;
}

export const calendarApi = {
  getAll: () =>
    api.get<CalendarEvent[]>('/calendar/events').then((r) => r.data),
  getById: (id: string) =>
    api.get<CalendarEvent>(`/calendar/events/${id}`).then((r) => r.data),
  syncEvent: (id: string) =>
    api.post(`/calendar/events/${id}/sync`).then((r) => r.data),
};

// Sync API

export interface ChannelSyncDetail {
  childName: string;
  channelName: string;
  messagesFound: number;
  skipped: boolean;
  skipReason?: string;
  startedAt: string;
  endedAt: string;
  messages?: { sender: string; content: string; timestamp: string }[];
}

export interface SyncLog {
  id: string;
  timestamp: string;
  status: 'success' | 'failed' | 'partial';
  messageCount: number;
  eventsCreated: number;
  startedAt: string | null;
  endedAt: string | null;
  channelDetails: ChannelSyncDetail[] | null;
}

export const syncApi = {
  triggerManual: () =>
    api.post('/sync/manual').then((r) => r.data),
  syncEvents: () =>
    api.post('/sync/events').then((r) => r.data),
  resetSyncState: () =>
    api.post<{ childrenReset: number; messagesReset: number }>('/sync/reset').then((r) => r.data),
  getLogs: (limit?: number) =>
    api.get<SyncLog[]>('/sync/logs', { params: limit ? { limit } : undefined }).then((r) => r.data),
  getErrorsUrl: () =>
    `${api.defaults.baseURL}/sync/errors`,
};

// Monitor API

export interface ChartDataset {
  label: string;
  data: number[];
}

export interface ChartResponse {
  labels: string[];
  datasets: ChartDataset[];
}

export interface SyncHistoryEntry {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  messageCount: number;
  eventsCreated: number;
  durationMs: number | null;
  channelDetails: ChannelSyncDetail[] | null;
}

export interface MonitorSummary {
  totalMessages: number;
  totalEvents: number;
  avgMessagesPerSync: number;
  avgSyncDurationMs: number;
  syncSuccessRate: number;
  totalSyncs: number;
  mostActiveChannel: string | null;
  lastSync: { timestamp: string; status: string } | null;
  previousPeriod: {
    totalMessages: number;
    totalEvents: number;
  };
}

export interface HeatmapData {
  channels: string[];
  dates: string[];
  data: number[][];
}

export interface MonitorQuery {
  from?: string;
  to?: string;
  childId?: string;
  groupBy?: 'day' | 'week' | 'month';
}

export const monitorApi = {
  getMessagesOverTime: (params?: MonitorQuery) =>
    api.get<ChartResponse>('/monitor/messages-over-time', { params }).then((r) => r.data),
  getEventsPerChannel: (params?: MonitorQuery) =>
    api.get<ChartResponse>('/monitor/events-per-channel', { params }).then((r) => r.data),
  getSyncHistory: (params?: MonitorQuery) =>
    api.get<SyncHistoryEntry[]>('/monitor/sync-history', { params }).then((r) => r.data),
  getSummary: (params?: MonitorQuery) =>
    api.get<MonitorSummary>('/monitor/summary', { params }).then((r) => r.data),
  getChannelsActivity: (params?: MonitorQuery) =>
    api.get<HeatmapData>('/monitor/channels-activity', { params }).then((r) => r.data),
};

// WhatsApp API

export interface WhatsAppStatus {
  status: string;
  connected: boolean;
}

export const whatsappApi = {
  getStatus: () =>
    api.get<WhatsAppStatus>('/whatsapp/status').then((r) => r.data),
  reconnect: () =>
    api.post<{ status: string }>('/whatsapp/reconnect').then((r) => r.data),
  getEventsUrl: () =>
    `${api.defaults.baseURL}/whatsapp/events`,
};

export interface LlmPrompt {
  value: string;
  default: string;
  isCustom: boolean;
}

export const llmPromptApi = {
  get: () => api.get<LlmPrompt>('/llm/prompt').then((r) => r.data),
  save: (value: string) =>
    api.put<LlmPrompt>('/llm/prompt', { value }).then((r) => r.data),
  reset: () => api.delete<LlmPrompt>('/llm/prompt').then((r) => r.data),
};

export interface NegativeExample {
  id: string;
  messageContent: string;
  extractedTitle: string;
  extractedDate: string | null;
  channel: string | null;
  createdAt: string;
}

export interface NegativeExamplesResponse {
  count: number;
  items: NegativeExample[];
}

export const negativeExamplesApi = {
  list: () =>
    api
      .get<NegativeExamplesResponse>('/llm/negative-examples')
      .then((r) => r.data),
  remove: (id: string) =>
    api.delete<void>(`/llm/negative-examples/${id}`).then(() => undefined),
  clear: () =>
    api.delete<void>('/llm/negative-examples').then(() => undefined),
};

export default api;
