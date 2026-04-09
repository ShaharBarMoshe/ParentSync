import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DashboardPage from './DashboardPage';

vi.mock('../services/api', () => ({
  messagesApi: {
    getAll: vi.fn(),
  },
  calendarApi: {
    getAll: vi.fn(),
  },
  syncApi: {
    triggerManual: vi.fn(),
    syncEvents: vi.fn(),
    getLogs: vi.fn(),
  },
}));

import { messagesApi, calendarApi, syncApi } from '../services/api';

const mockMessages = [
  {
    id: '1',
    source: 'whatsapp' as const,
    content: 'School trip on Friday',
    timestamp: new Date().toISOString(),
    channel: 'parents-group',
    sender: 'Teacher',
    parsed: true,
    createdAt: new Date().toISOString(),
  },
];

const mockEvents = [
  {
    id: '1',
    title: 'School Trip',
    description: null,
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    time: '09:00',
    location: 'Zoo',
    source: 'whatsapp' as const,
    sourceId: '1',
    googleEventId: 'g1',
    syncedToGoogle: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const mockLogs = [
  {
    id: '1',
    timestamp: new Date().toISOString(),
    status: 'success' as const,
    messageCount: 5,
    eventsCreated: 2,
  },
];

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardPage', () => {
  it('shows loading state initially', () => {
    vi.mocked(messagesApi.getAll).mockReturnValue(new Promise(() => {}));
    vi.mocked(calendarApi.getAll).mockReturnValue(new Promise(() => {}));
    vi.mocked(syncApi.getLogs).mockReturnValue(new Promise(() => {}));

    renderDashboard();
    expect(screen.getByText('Loading dashboard...')).toBeInTheDocument();
  });

  it('renders dashboard with data', async () => {
    vi.mocked(messagesApi.getAll).mockResolvedValue(mockMessages);
    vi.mocked(calendarApi.getAll).mockResolvedValue(mockEvents);
    vi.mocked(syncApi.getLogs).mockResolvedValue(mockLogs);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    expect(screen.getByText('parents-group')).toBeInTheDocument();
    expect(screen.getByText('School Trip')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows empty states when no data', async () => {
    vi.mocked(messagesApi.getAll).mockResolvedValue([]);
    vi.mocked(calendarApi.getAll).mockResolvedValue([]);
    vi.mocked(syncApi.getLogs).mockResolvedValue([]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('No messages yet')).toBeInTheDocument();
    });
    expect(screen.getByText('No events scheduled')).toBeInTheDocument();
  });

  it('handles sync button click', async () => {
    vi.mocked(messagesApi.getAll).mockResolvedValue([]);
    vi.mocked(calendarApi.getAll).mockResolvedValue([]);
    vi.mocked(syncApi.getLogs).mockResolvedValue([]);
    vi.mocked(syncApi.triggerManual).mockResolvedValue({});
    vi.mocked(syncApi.syncEvents).mockResolvedValue({});

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Sync Now')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Sync Now'));

    expect(syncApi.triggerManual).toHaveBeenCalled();
    expect(syncApi.syncEvents).toHaveBeenCalled();
  });

  it('shows error state on API failure', async () => {
    vi.mocked(messagesApi.getAll).mockRejectedValue(new Error('fail'));
    vi.mocked(calendarApi.getAll).mockRejectedValue(new Error('fail'));
    vi.mocked(syncApi.getLogs).mockRejectedValue(new Error('fail'));

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Failed to load dashboard data')).toBeInTheDocument();
    });
  });

  it('expands message on click', async () => {
    vi.mocked(messagesApi.getAll).mockResolvedValue(mockMessages);
    vi.mocked(calendarApi.getAll).mockResolvedValue([]);
    vi.mocked(syncApi.getLogs).mockResolvedValue([]);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('parents-group')).toBeInTheDocument();
    });

    const messageButton = screen.getByText('parents-group').closest('button')!;
    await userEvent.click(messageButton);

    const preview = screen.getByText('School trip on Friday');
    expect(preview.className).toContain('expanded');
  });
});
