import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { messagesApi, calendarApi, syncApi, approvalApi } from '../services/api';
import type { Message, CalendarEvent, SyncLog, ChannelSyncDetail } from '../services/api';
import Icon from '../components/icons/Icon';

export default function DashboardPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);
  const [messagesLimit, setMessagesLimit] = useState(10);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  async function handleApproval(eventId: string, action: 'approve' | 'reject') {
    setApprovingId(eventId);
    try {
      const updated =
        action === 'approve'
          ? await approvalApi.approve(eventId)
          : await approvalApi.reject(eventId);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventId
            ? { ...e, approvalStatus: updated.approvalStatus }
            : e,
        ),
      );
    } catch (e: any) {
      setError(
        `Failed to ${action} event: ${e?.response?.data?.message ?? e?.message ?? 'unknown error'}`,
      );
    } finally {
      setApprovingId(null);
    }
  }

  const loadData = useCallback(async () => {
    try {
      const today = new Date();
      const weekFromToday = new Date(today);
      weekFromToday.setDate(weekFromToday.getDate() + 7);
      const ymd = (d: Date) => d.toISOString().slice(0, 10);

      const [msgs, evts, logs] = await Promise.all([
        messagesApi.getAll(),
        calendarApi.getInRange(ymd(today), ymd(weekFromToday)),
        syncApi.getLogs(5),
      ]);
      setMessages(msgs);

      // Hide events whose time has already passed. Date-only items stay
      // visible through the end of their day (`23:59:59`) since they're
      // typically "things to bring / do today" with no specific deadline.
      const now = Date.now();
      const isPast = (e: CalendarEvent) => {
        const suffix = e.time ? `T${e.time}:00` : 'T23:59:59';
        return new Date(e.date + suffix).getTime() < now;
      };
      const upcoming = evts
        .filter((e) => !isPast(e))
        .sort((a, b) => {
          const aKey = a.date + (a.time ?? '23:59');
          const bKey = b.date + (b.time ?? '23:59');
          return aKey.localeCompare(bKey);
        });
      setEvents(upcoming);
      setSyncLogs(logs);
      setError(null);
    } catch {
      setError('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      await syncApi.triggerManual();
      await syncApi.syncEvents();
      await loadData();
    } catch {
      setError('Sync failed. Please try again.');
    } finally {
      setSyncing(false);
    }
  }

  const lastLog = syncLogs[0];
  const totalMessagesProcessed = syncLogs.reduce((sum, l) => sum + l.messageCount, 0);
  const totalEventsCreated = syncLogs.reduce((sum, l) => sum + l.eventsCreated, 0);

  function formatDuration(startedAt: string | null, endedAt: string | null): string {
    if (!startedAt || !endedAt) return '-';
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-loading">
          <div className="dashboard-loading-spinner" />
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p>Overview of your messages, events, and sync status.</p>
        </div>
        <div className="dashboard-header-actions">
          <Link to="/calendar" className="btn btn--secondary btn--sm">
            <Icon name="calendar" size={14} /> Calendar
          </Link>
          <Link to="/settings" className="btn btn--secondary btn--sm">
            <Icon name="settings" size={14} /> Settings
          </Link>
        </div>
      </div>

      {error && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          <span>{error}</span>
          <Link to="/settings" className="settings-alert__link"><Icon name="settings" size={14} /> Settings</Link>
          <button type="button" className="settings-alert__dismiss" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}

      {/* Sync Status */}
      <div className="dashboard-section dashboard-sync">
        <div className="dashboard-sync-info">
          <h3 className="dashboard-section-title"><Icon name="refresh-cw" size={16} /> Sync Status</h3>
          <div className="dashboard-sync-metrics">
            <div className="dashboard-metric">
              <span className="dashboard-metric-value">{totalMessagesProcessed}</span>
              <span className="dashboard-metric-label">Messages processed</span>
            </div>
            <div className="dashboard-metric">
              <span className="dashboard-metric-value">{totalEventsCreated}</span>
              <span className="dashboard-metric-label">Events created</span>
            </div>
            <div className="dashboard-metric">
              <span className="dashboard-metric-value">
                {lastLog ? new Date(lastLog.timestamp).toLocaleString() : 'Never'}
              </span>
              <span className="dashboard-metric-label">Last sync</span>
            </div>
            {lastLog && (
              <div className="dashboard-metric">
                <span className="dashboard-metric-value">
                  {formatDuration(lastLog.startedAt, lastLog.endedAt)}
                </span>
                <span className="dashboard-metric-label">Duration</span>
              </div>
            )}
            {lastLog && (
              <div className="dashboard-metric">
                <span className={`dashboard-sync-badge dashboard-sync-badge--${lastLog.status}`}>
                  {lastLog.status}
                </span>
                <span className="dashboard-metric-label">Status</span>
              </div>
            )}
          </div>
        </div>
        <button
          className="btn btn--primary"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? <><Icon name="loader" size={16} className="icon-spin" /> Syncing...</> : <><Icon name="refresh-cw" size={16} /> Sync Now</>}
        </button>
      </div>

      {/* Sync Log History */}
      {syncLogs.length > 0 && (
        <div className="dashboard-section">
          <h3 className="dashboard-section-title"><Icon name="clock" size={16} /> Sync History</h3>
          <ul className="dashboard-sync-logs">
            {syncLogs.map((log) => (
              <li key={log.id} className="dashboard-sync-log">
                <button
                  className="dashboard-sync-log-header"
                  onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                  aria-expanded={expandedLog === log.id}
                >
                  <span className={`dashboard-sync-badge dashboard-sync-badge--${log.status}`}>
                    {log.status}
                  </span>
                  <span className="dashboard-sync-log-time">
                    {log.startedAt ? new Date(log.startedAt).toLocaleString() : new Date(log.timestamp).toLocaleString()}
                  </span>
                  <span className="dashboard-sync-log-duration">
                    {formatDuration(log.startedAt, log.endedAt)}
                  </span>
                  <span className="dashboard-sync-log-count">
                    {log.messageCount} msgs
                  </span>
                </button>
                {expandedLog === log.id && log.channelDetails && log.channelDetails.length > 0 && (
                  <div className="dashboard-sync-log-details">
                    <table className="dashboard-sync-log-table">
                      <thead>
                        <tr>
                          <th>Child</th>
                          <th>Channel</th>
                          <th>Messages</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {log.channelDetails.map((detail: ChannelSyncDetail, idx: number) => (
                          <tr key={idx} className={detail.skipped ? 'dashboard-sync-log-skipped' : ''}>
                            <td>{detail.childName}</td>
                            <td>{detail.channelName}</td>
                            <td>{detail.messagesFound}</td>
                            <td>{formatDuration(detail.startedAt, detail.endedAt)}</td>
                            <td>
                              {detail.skipped ? (
                                <span className="dashboard-sync-skip-reason" title={detail.skipReason}>
                                  Skipped: {detail.skipReason}
                                </span>
                              ) : (
                                <span className="dashboard-sync-badge dashboard-sync-badge--success">synced</span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {log.channelDetails.some((d) => d.messages && d.messages.length > 0) && (
                          <tr>
                            <td colSpan={5} style={{ padding: 0 }}>
                              <details className="dashboard-sync-messages-details">
                                <summary>View synced messages</summary>
                                <ul className="dashboard-sync-messages-list">
                                  {log.channelDetails.flatMap((detail) =>
                                    (detail.messages ?? []).map((msg, mi) => (
                                      <li key={`${detail.channelName}-${mi}`} className="dashboard-sync-message-item">
                                        <span className="dashboard-sync-message-meta">
                                          [{detail.channelName}] {msg.sender} &middot; {new Date(msg.timestamp).toLocaleString()}
                                        </span>
                                        <span className="dashboard-sync-message-content">{msg.content}</span>
                                      </li>
                                    )),
                                  )}
                                </ul>
                              </details>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {expandedLog === log.id && (!log.channelDetails || log.channelDetails.length === 0) && (
                  <div className="dashboard-sync-log-details">
                    <p className="dashboard-empty-text">No WhatsApp channel details for this sync.</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="dashboard-grid">
        {/* Recent Messages */}
        <div className="dashboard-section">
          <h3 className="dashboard-section-title"><Icon name="message-circle" size={16} /> Recent Messages</h3>
          {messages.length === 0 ? (
            <div className="dashboard-empty">
              <p>No messages yet</p>
              <span>Messages from WhatsApp and Email will appear here after syncing.</span>
            </div>
          ) : (
            <>
              <ul className="dashboard-messages">
                {messages.slice(0, messagesLimit).map((msg) => (
                  <li key={msg.id} className="dashboard-message">
                    <button
                      className="dashboard-message-header"
                      onClick={() => setExpandedMessage(expandedMessage === msg.id ? null : msg.id)}
                      aria-expanded={expandedMessage === msg.id}
                    >
                      <span className={`dashboard-source dashboard-source--${msg.source}`}>
                        {msg.source === 'whatsapp' ? <Icon name="whatsapp" size={14} /> : <Icon name="mail" size={14} />}
                      </span>
                      <span className="dashboard-message-channel">{msg.channel}</span>
                      <span className="dashboard-message-time">
                        {new Date(msg.timestamp).toLocaleDateString()}
                      </span>
                    </button>
                    <p className={`dashboard-message-preview ${expandedMessage === msg.id ? 'dashboard-message-preview--expanded' : ''}`}>
                      {msg.content}
                    </p>
                  </li>
                ))}
              </ul>
              {messages.length > messagesLimit && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => setMessagesLimit((prev) => prev + 20)}
                >
                  Show more ({messages.length - messagesLimit} remaining)
                </button>
              )}
            </>
          )}
        </div>

        {/* Upcoming Events */}
        <div className="dashboard-section">
          <h3 className="dashboard-section-title"><Icon name="calendar-check" size={16} /> Upcoming Events (7 days)</h3>
          {events.length === 0 ? (
            <div className="dashboard-empty">
              <p>No events scheduled</p>
              <span>Upcoming calendar events will appear here.</span>
            </div>
          ) : (
            <ul className="dashboard-events">
              {events.map((evt) => {
                const isPending = evt.approvalStatus === 'pending_approval';
                const isApproved = evt.approvalStatus === 'approved';
                const isRejected = evt.approvalStatus === 'rejected';
                const busy = approvingId === evt.id;
                return (
                <li key={evt.id} className={`dashboard-event${evt.syncType === 'task' ? ' dashboard-event--task' : ''}${isRejected ? ' dashboard-event--rejected' : ''}`}>
                  <div className="dashboard-event-header">
                    <span className="dashboard-event-type" title={evt.syncType === 'task' ? 'Task' : 'Event'}>
                      <Icon name={evt.syncType === 'task' ? 'square-check' : 'calendar'} size={14} />
                    </span>
                    <span className="dashboard-event-title">{evt.title}</span>
                    {isPending && (
                      <span className="dashboard-event-status dashboard-event-status--pending" title="Pending approval">
                        <Icon name="clock" size={14} /> Pending
                      </span>
                    )}
                    {isApproved && (
                      <span className="dashboard-event-status dashboard-event-status--approved" title="Approved">
                        <Icon name="circle-check" size={14} /> Approved
                      </span>
                    )}
                    {isRejected && (
                      <span className="dashboard-event-status dashboard-event-status--rejected" title="Rejected">
                        <Icon name="circle-x" size={14} /> Rejected
                      </span>
                    )}
                    {evt.syncedToGoogle && (
                      <span className="dashboard-event-synced" title={evt.syncType === 'task' ? 'Synced to Google Tasks' : 'Synced to Google Calendar'}>
                        <Icon name="circle-check" size={16} />
                      </span>
                    )}
                  </div>
                  <div className="dashboard-event-details">
                    <span>{new Date(evt.date + 'T00:00:00').toLocaleDateString()}</span>
                    {evt.time && <span>{evt.time}</span>}
                    {evt.location && <span>{evt.location}</span>}
                  </div>
                  {evt.source && (
                    <span className={`dashboard-source dashboard-source--${evt.source}`}>
                      {evt.source === 'whatsapp' ? <Icon name="whatsapp" size={14} /> : <Icon name="mail" size={14} />}
                    </span>
                  )}
                  {isPending && (
                    <div className="dashboard-event-actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={busy}
                        onClick={() => handleApproval(evt.id, 'approve')}
                      >
                        <Icon name="check" size={14} /> Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={busy}
                        onClick={() => handleApproval(evt.id, 'reject')}
                      >
                        <Icon name="x" size={14} /> Reject
                      </button>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
