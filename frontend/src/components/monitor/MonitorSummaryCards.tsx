import type { MonitorSummary } from '../../services/api';
import Icon from '../icons/Icon';

interface Props {
  data: MonitorSummary | null;
  loading: boolean;
}

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return <span className="monitor-trend monitor-trend--up">+{current}</span>;

  const diff = current - previous;
  const pct = Math.round((diff / previous) * 100);
  if (diff === 0) return <span className="monitor-trend monitor-trend--flat">0%</span>;
  if (diff > 0) return <span className="monitor-trend monitor-trend--up">+{pct}%</span>;
  return <span className="monitor-trend monitor-trend--down">{pct}%</span>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export default function MonitorSummaryCards({ data, loading }: Props) {
  if (loading || !data) {
    return (
      <div className="monitor-summary">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="monitor-summary-card monitor-summary-card--loading">
            <div className="monitor-summary-card-skeleton" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="monitor-summary">
      <div className="monitor-summary-card">
        <Icon name="message-circle" size={20} className="monitor-summary-card-icon" />
        <span className="monitor-summary-card-value">{data.totalMessages}</span>
        <span className="monitor-summary-card-label">Messages Scanned</span>
        <TrendArrow current={data.totalMessages} previous={data.previousPeriod.totalMessages} />
      </div>
      <div className="monitor-summary-card">
        <Icon name="calendar-check" size={20} className="monitor-summary-card-icon" />
        <span className="monitor-summary-card-value">{data.totalEvents}</span>
        <span className="monitor-summary-card-label">Events Created</span>
        <TrendArrow current={data.totalEvents} previous={data.previousPeriod.totalEvents} />
      </div>
      <div className="monitor-summary-card">
        <Icon name="clock" size={20} className="monitor-summary-card-icon" />
        <span className="monitor-summary-card-value">{formatDuration(data.avgSyncDurationMs)}</span>
        <span className="monitor-summary-card-label">Avg Sync Duration</span>
      </div>
      <div className="monitor-summary-card">
        <Icon name="circle-check" size={20} className="monitor-summary-card-icon" />
        <span className={`monitor-summary-card-value ${data.syncSuccessRate >= 80 ? 'monitor-summary-card-value--success' : data.syncSuccessRate >= 50 ? 'monitor-summary-card-value--warning' : 'monitor-summary-card-value--error'}`}>
          {data.syncSuccessRate}%
        </span>
        <span className="monitor-summary-card-label">Sync Success Rate</span>
        <span className="monitor-summary-card-detail">{data.totalSyncs} syncs</span>
      </div>
      <div className="monitor-summary-card">
        <Icon name="chart-line" size={20} className="monitor-summary-card-icon" />
        <span className="monitor-summary-card-value">{data.mostActiveChannel || '-'}</span>
        <span className="monitor-summary-card-label">Most Active Channel</span>
      </div>
      <div className="monitor-summary-card">
        <Icon name="refresh-cw" size={20} className="monitor-summary-card-icon" />
        <span className="monitor-summary-card-value">
          {data.lastSync ? new Date(data.lastSync.timestamp).toLocaleString() : 'Never'}
        </span>
        <span className="monitor-summary-card-label">Last Sync</span>
        {data.lastSync && (
          <span className={`dashboard-sync-badge dashboard-sync-badge--${data.lastSync.status}`}>
            {data.lastSync.status}
          </span>
        )}
      </div>
    </div>
  );
}
