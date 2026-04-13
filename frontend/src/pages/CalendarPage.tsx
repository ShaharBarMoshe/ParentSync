import { useState, useEffect, useCallback, useMemo } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { calendarApi } from '../services/api';
import type { CalendarEvent } from '../services/api';
import Icon from '../components/icons/Icon';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { 'en-US': enUS },
});

type SourceFilter = 'all' | 'whatsapp' | 'email';

interface CalendarEntry {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resource: CalendarEvent;
}

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('all');

  const loadEvents = useCallback(async () => {
    try {
      const data = await calendarApi.getAll();
      setEvents(data);
      setError(null);
    } catch {
      setError('Failed to load calendar events');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((e) => e.source === filter);
  }, [events, filter]);

  const calendarEntries: CalendarEntry[] = useMemo(() => {
    return filteredEvents.map((evt) => {
      const dateStr = evt.time ? `${evt.date}T${evt.time}:00` : `${evt.date}T00:00:00`;
      const start = new Date(dateStr);
      const end = new Date(start);
      if (evt.time) {
        end.setHours(end.getHours() + 1);
      } else {
        end.setDate(end.getDate() + 1);
      }
      return {
        id: evt.id,
        title: evt.title,
        start,
        end,
        resource: evt,
      };
    });
  }, [filteredEvents]);

  function eventStyleGetter(event: CalendarEntry) {
    const source = event.resource.source;
    const isTask = event.resource.syncType === 'task';
    let backgroundColor = 'var(--accent)';
    if (source === 'whatsapp') backgroundColor = '#25D366';
    else if (source === 'email') backgroundColor = '#EA4335';

    return {
      style: {
        backgroundColor,
        borderRadius: '4px',
        border: isTask ? '2px dashed rgba(255,255,255,0.5)' : 'none',
        color: '#fff',
        fontSize: '13px',
        padding: '2px 6px',
      },
    };
  }

  if (loading) {
    return (
      <div className="calendar-page">
        <div className="dashboard-loading">
          <div className="dashboard-loading-spinner" />
          <p>Loading calendar...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="calendar-page">
      <div className="calendar-header">
        <div>
          <h1>Calendar</h1>
          <p>View your synced events.</p>
        </div>
        <div className="calendar-filters">
          {(['all', 'whatsapp', 'email'] as SourceFilter[]).map((f) => (
            <button
              key={f}
              className={`calendar-filter ${filter === f ? 'calendar-filter--active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? <><Icon name="list-filter" size={14} /> All</> : f === 'whatsapp' ? <><Icon name="whatsapp" size={14} /> WhatsApp</> : <><Icon name="mail" size={14} /> Email</>}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          <span>{error}</span>
          <button type="button" className="settings-alert__dismiss" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}

      <div className="calendar-container">
        <Calendar
          localizer={localizer}
          events={calendarEntries}
          startAccessor="start"
          endAccessor="end"
          style={{ height: 600 }}
          eventPropGetter={eventStyleGetter}
          onSelectEvent={(event) => setSelectedEvent(event.resource)}
          views={['month', 'week', 'day']}
          defaultView="month"
          popup
        />
      </div>

      {/* Event Detail Modal */}
      {selectedEvent && (
        <div className="calendar-modal-backdrop" onClick={() => setSelectedEvent(null)}>
          <div className="calendar-modal" onClick={(e) => e.stopPropagation()}>
            <div className="calendar-modal-header">
              <h3>
                <Icon name={selectedEvent.syncType === 'task' ? 'square-check' : 'calendar'} size={16} />
                {' '}{selectedEvent.title}
              </h3>
              <button
                className="calendar-modal-close"
                onClick={() => setSelectedEvent(null)}
                aria-label="Close"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="calendar-modal-body">
              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Date</span>
                <span>{new Date(selectedEvent.date + 'T00:00:00').toLocaleDateString()}</span>
              </div>
              {selectedEvent.time && (
                <div className="calendar-modal-row">
                  <span className="calendar-modal-label">Time</span>
                  <span>{selectedEvent.time}</span>
                </div>
              )}
              {selectedEvent.location && (
                <div className="calendar-modal-row">
                  <span className="calendar-modal-label">Location</span>
                  <span>{selectedEvent.location}</span>
                </div>
              )}
              {selectedEvent.description && (
                <div className="calendar-modal-row">
                  <span className="calendar-modal-label">Description</span>
                  <span>{selectedEvent.description}</span>
                </div>
              )}
              {selectedEvent.source && (
                <div className="calendar-modal-row">
                  <span className="calendar-modal-label">Source</span>
                  <span className={`dashboard-source dashboard-source--${selectedEvent.source}`}>
                    {selectedEvent.source === 'whatsapp' ? <><Icon name="whatsapp" size={14} /> WhatsApp</> : <><Icon name="mail" size={14} /> Email</>}
                  </span>
                </div>
              )}
              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Type</span>
                <span>{selectedEvent.syncType === 'task' ? 'Task' : 'Event'}</span>
              </div>
              <div className="calendar-modal-row">
                <span className="calendar-modal-label">Synced</span>
                <span className={selectedEvent.syncedToGoogle ? 'calendar-synced' : 'calendar-unsynced'}>
                  {selectedEvent.syncedToGoogle
                    ? selectedEvent.syncType === 'task' ? 'Synced to Google Tasks' : 'Synced to Google Calendar'
                    : 'Not synced'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
