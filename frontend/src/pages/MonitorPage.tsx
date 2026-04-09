import { useState, useEffect, useCallback } from 'react';
import {
  monitorApi,
  childrenApi,
} from '../services/api';
import type {
  ChartResponse,
  SyncHistoryEntry,
  MonitorSummary,
  HeatmapData,
  MonitorQuery,
  Child,
} from '../services/api';
import Icon from '../components/icons/Icon';
import MonitorSummaryCards from '../components/monitor/MonitorSummaryCards';
import MessagesOverTimeChart from '../components/monitor/MessagesOverTimeChart';
import EventsPerChannelChart from '../components/monitor/EventsPerChannelChart';
import SyncHistoryChart from '../components/monitor/SyncHistoryChart';
import ChannelActivityHeatmap from '../components/monitor/ChannelActivityHeatmap';

type DateRange = '7d' | '30d' | '90d';

function getDateRange(range: DateRange): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  switch (range) {
    case '7d':
      from.setDate(from.getDate() - 7);
      break;
    case '30d':
      from.setDate(from.getDate() - 30);
      break;
    case '90d':
      from.setDate(from.getDate() - 90);
      break;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function getGroupBy(range: DateRange): 'day' | 'week' | 'month' {
  switch (range) {
    case '7d':
      return 'day';
    case '30d':
      return 'day';
    case '90d':
      return 'week';
  }
}

export default function MonitorPage() {
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [childId, setChildId] = useState<string>('');
  const [children, setChildren] = useState<Child[]>([]);

  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [messagesData, setMessagesData] = useState<ChartResponse | null>(null);
  const [eventsData, setEventsData] = useState<ChartResponse | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[] | null>(null);
  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { from, to } = getDateRange(dateRange);
    const groupBy = getGroupBy(dateRange);
    const params: MonitorQuery = { from, to, groupBy };
    if (childId) params.childId = childId;

    try {
      const [summaryRes, messagesRes, eventsRes, syncRes, heatmapRes] =
        await Promise.all([
          monitorApi.getSummary(params),
          monitorApi.getMessagesOverTime(params),
          monitorApi.getEventsPerChannel(params),
          monitorApi.getSyncHistory(params),
          monitorApi.getChannelsActivity(params),
        ]);

      setSummary(summaryRes);
      setMessagesData(messagesRes);
      setEventsData(eventsRes);
      setSyncHistory(syncRes);
      setHeatmapData(heatmapRes);
    } catch {
      setError('Failed to load monitor data.');
    } finally {
      setLoading(false);
    }
  }, [dateRange, childId]);

  useEffect(() => {
    childrenApi.getAll().then(setChildren).catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="monitor-page">
      <div className="monitor-header">
        <div>
          <h1>Monitor</h1>
          <p>Analytics and insights for your sync activity.</p>
        </div>
        <div className="monitor-filters">
          <div className="monitor-filter-group">
            <label className="monitor-filter-label" htmlFor="date-range">Period</label>
            <select
              id="date-range"
              className="monitor-select"
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateRange)}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </div>
          <div className="monitor-filter-group">
            <label className="monitor-filter-label" htmlFor="child-filter">Child</label>
            <select
              id="child-filter"
              className="monitor-select"
              value={childId}
              onChange={(e) => setChildId(e.target.value)}
            >
              <option value="">All children</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          <span>{error}</span>
          <button type="button" className="settings-alert__dismiss" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}

      <MonitorSummaryCards data={summary} loading={loading} />

      <div className="monitor-charts-grid">
        <MessagesOverTimeChart data={messagesData} loading={loading} />
        <EventsPerChannelChart data={eventsData} loading={loading} />
      </div>

      <SyncHistoryChart data={syncHistory} loading={loading} />

      <ChannelActivityHeatmap data={heatmapData} loading={loading} />
    </div>
  );
}
