import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CalendarPage from './CalendarPage';

vi.mock('../services/api', () => ({
  calendarApi: {
    getAll: vi.fn(),
  },
}));

import { calendarApi } from '../services/api';

const mockEvents = [
  {
    id: '1',
    title: 'School Trip',
    description: 'Visit to the zoo',
    date: '2026-03-25',
    time: '09:00',
    location: 'City Zoo',
    source: 'whatsapp' as const,
    sourceId: 'm1',
    googleEventId: 'g1',
    syncedToGoogle: true,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
  },
  {
    id: '2',
    title: 'Parent Meeting',
    description: null,
    date: '2026-03-26',
    time: '18:00',
    location: null,
    source: 'email' as const,
    sourceId: 'm2',
    googleEventId: null,
    syncedToGoogle: false,
    createdAt: '2026-03-20T11:00:00Z',
    updatedAt: '2026-03-20T11:00:00Z',
  },
];

function renderCalendar() {
  return render(
    <MemoryRouter>
      <CalendarPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CalendarPage', () => {
  it('shows loading state initially', () => {
    vi.mocked(calendarApi.getAll).mockReturnValue(new Promise(() => {}));

    renderCalendar();
    expect(screen.getByText('Loading calendar...')).toBeInTheDocument();
  });

  it('renders calendar with header', async () => {
    vi.mocked(calendarApi.getAll).mockResolvedValue(mockEvents);

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    vi.mocked(calendarApi.getAll).mockRejectedValue(new Error('fail'));

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('Failed to load calendar events')).toBeInTheDocument();
    });
  });

  it('filters events by source', async () => {
    vi.mocked(calendarApi.getAll).mockResolvedValue(mockEvents);

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    const whatsappFilter = screen.getByText('WhatsApp');
    await userEvent.click(whatsappFilter);

    expect(whatsappFilter.className).toContain('active');
  });

  it('opens event detail modal on event click', async () => {
    // Use events in the current month so they appear in the default view
    const today = new Date();
    const eventDate = new Date(today.getFullYear(), today.getMonth(), 15);
    const dateStr = eventDate.toISOString().split('T')[0];
    const currentMonthEvents = mockEvents.map((e) => ({ ...e, date: dateStr }));

    vi.mocked(calendarApi.getAll).mockResolvedValue(currentMonthEvents);

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    // react-big-calendar renders events with .rbc-event in the current month view
    const eventEl = await waitFor(() => {
      const el = document.querySelector('.rbc-event');
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(eventEl);

    // Modal should appear with event details
    await waitFor(() => {
      expect(screen.getByText('City Zoo')).toBeInTheDocument();
    });
  });

  it('closes modal when close button is clicked', async () => {
    const today = new Date();
    const eventDate = new Date(today.getFullYear(), today.getMonth(), 15);
    const dateStr = eventDate.toISOString().split('T')[0];
    const currentMonthEvents = mockEvents.map((e) => ({ ...e, date: dateStr }));

    vi.mocked(calendarApi.getAll).mockResolvedValue(currentMonthEvents);

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    const eventEl = await waitFor(() => {
      const el = document.querySelector('.rbc-event');
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(eventEl);

    await waitFor(() => {
      expect(screen.getByLabelText('Close')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => {
      expect(screen.queryByText('City Zoo')).not.toBeInTheDocument();
    });
  });
});
