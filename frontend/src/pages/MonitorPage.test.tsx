import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MonitorPage from './MonitorPage';

// Mock recharts to avoid SVG rendering issues in jsdom
vi.mock('recharts', () => {
  const MockComponent = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: MockComponent,
    LineChart: MockComponent,
    Line: MockComponent,
    BarChart: MockComponent,
    Bar: MockComponent,
    ComposedChart: MockComponent,
    XAxis: MockComponent,
    YAxis: MockComponent,
    Tooltip: MockComponent,
    Legend: MockComponent,
    CartesianGrid: MockComponent,
    Cell: MockComponent,
  };
});

vi.mock('../services/api', () => ({
  monitorApi: {
    getSummary: vi.fn(),
    getMessagesOverTime: vi.fn(),
    getEventsPerChannel: vi.fn(),
    getSyncHistory: vi.fn(),
    getChannelsActivity: vi.fn(),
  },
  childrenApi: {
    getAll: vi.fn(),
  },
}));

import { monitorApi, childrenApi } from '../services/api';

const mockSummary = {
  totalMessages: 42,
  totalEvents: 10,
  avgMessagesPerSync: 7,
  avgSyncDurationMs: 3200,
  syncSuccessRate: 85,
  totalSyncs: 6,
  mostActiveChannel: 'Grade 3A Parents',
  lastSync: { timestamp: '2026-04-03T14:00:00Z', status: 'success' },
  previousPeriod: {
    totalMessages: 30,
    totalEvents: 8,
  },
};

const mockMessagesData = {
  labels: ['2026-03-15', '2026-03-16'],
  datasets: [
    { label: 'WhatsApp', data: [5, 8] },
    { label: 'Email', data: [2, 3] },
  ],
};

const mockEventsData = {
  labels: ['Grade 3A Parents', 'School Updates'],
  datasets: [{ label: 'Events', data: [6, 4] }],
};

const mockSyncHistory = [
  {
    id: 's1',
    startedAt: '2026-04-03T14:00:00Z',
    endedAt: '2026-04-03T14:01:00Z',
    status: 'success',
    messageCount: 10,
    eventsCreated: 3,
    durationMs: 60000,
    channelDetails: null,
  },
];

const mockHeatmapData = {
  channels: ['Grade 3A Parents'],
  dates: ['2026-03-15', '2026-03-16'],
  data: [[3, 5]],
};

const mockChildren = [
  {
    id: 'child-1',
    name: 'Yoni',
    channelNames: 'Grade 3A Parents',
    teacherEmails: null,
    calendarColor: null,
    lastScanAt: null,
    order: 0,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
  },
];

function renderMonitor() {
  return render(
    <MemoryRouter>
      <MonitorPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MonitorPage', () => {
  it('shows loading state initially', () => {
    vi.mocked(monitorApi.getSummary).mockReturnValue(new Promise(() => {}));
    vi.mocked(monitorApi.getMessagesOverTime).mockReturnValue(new Promise(() => {}));
    vi.mocked(monitorApi.getEventsPerChannel).mockReturnValue(new Promise(() => {}));
    vi.mocked(monitorApi.getSyncHistory).mockReturnValue(new Promise(() => {}));
    vi.mocked(monitorApi.getChannelsActivity).mockReturnValue(new Promise(() => {}));
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();
    expect(screen.getByText('Monitor')).toBeInTheDocument();
    // Summary cards show loading skeletons (6 of them)
    const skeletons = document.querySelectorAll('.monitor-summary-card--loading');
    expect(skeletons.length).toBe(6);
  });

  it('renders summary cards with data', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });
    expect(screen.getByText('Messages Scanned')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Events Created')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('Sync Success Rate')).toBeInTheDocument();
    expect(screen.getAllByText('Grade 3A Parents').length).toBeGreaterThan(0);
    expect(screen.getByText('Most Active Channel')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    vi.mocked(monitorApi.getSummary).mockRejectedValue(new Error('fail'));
    vi.mocked(monitorApi.getMessagesOverTime).mockRejectedValue(new Error('fail'));
    vi.mocked(monitorApi.getEventsPerChannel).mockRejectedValue(new Error('fail'));
    vi.mocked(monitorApi.getSyncHistory).mockRejectedValue(new Error('fail'));
    vi.mocked(monitorApi.getChannelsActivity).mockRejectedValue(new Error('fail'));
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load monitor data/i);
    });
  });

  it('renders chart titles after data loads', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('Messages Over Time')).toBeInTheDocument();
    });
    expect(screen.getByText('Events Per Channel')).toBeInTheDocument();
    expect(screen.getByText('Sync History')).toBeInTheDocument();
    expect(screen.getByText('Channel Activity')).toBeInTheDocument();
  });

  it('renders date range and child filter controls', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue(mockChildren);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByLabelText('Period')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Child')).toBeInTheDocument();

    // Default period is 30d
    const periodSelect = screen.getByLabelText('Period') as HTMLSelectElement;
    expect(periodSelect.value).toBe('30d');

    // Child filter shows "All children" by default
    const childSelect = screen.getByLabelText('Child') as HTMLSelectElement;
    expect(childSelect.value).toBe('');
  });

  it('changes date range and reloads data', async () => {
    const user = userEvent.setup();
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    // Initial load calls each API once
    expect(vi.mocked(monitorApi.getSummary)).toHaveBeenCalledTimes(1);

    // Change to 7 days
    await user.selectOptions(screen.getByLabelText('Period'), '7d');

    // Data should be refetched
    await waitFor(() => {
      expect(vi.mocked(monitorApi.getSummary)).toHaveBeenCalledTimes(2);
    });
  });

  it('populates child filter dropdown from API', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue(mockChildren);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('Yoni')).toBeInTheDocument();
    });

    // The child filter should have "All children" and "Yoni"
    const childSelect = screen.getByLabelText('Child') as HTMLSelectElement;
    const options = Array.from(childSelect.options).map((o) => o.text);
    expect(options).toContain('All children');
    expect(options).toContain('Yoni');
  });

  it('shows empty chart states when no data returned', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue(mockSummary);
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue({ labels: [], datasets: [] });
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue({ labels: [], datasets: [] });
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue([]);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue({ channels: [], dates: [], data: [] });
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('No message data for this period.')).toBeInTheDocument();
    });
    expect(screen.getByText('No event data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No sync data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No channel activity data for this period.')).toBeInTheDocument();
  });

  it('displays avg sync duration formatted correctly', async () => {
    vi.mocked(monitorApi.getSummary).mockResolvedValue({ ...mockSummary, avgSyncDurationMs: 3200 });
    vi.mocked(monitorApi.getMessagesOverTime).mockResolvedValue(mockMessagesData);
    vi.mocked(monitorApi.getEventsPerChannel).mockResolvedValue(mockEventsData);
    vi.mocked(monitorApi.getSyncHistory).mockResolvedValue(mockSyncHistory);
    vi.mocked(monitorApi.getChannelsActivity).mockResolvedValue(mockHeatmapData);
    vi.mocked(childrenApi.getAll).mockResolvedValue([]);

    renderMonitor();

    await waitFor(() => {
      expect(screen.getByText('3s')).toBeInTheDocument();
    });
    expect(screen.getByText('Avg Sync Duration')).toBeInTheDocument();
  });
});
