import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { SyncHistoryEntry } from '../../services/api';

interface Props {
  data: SyncHistoryEntry[] | null;
  loading: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  success: '#22c55e',
  partial: '#f97316',
  failed: '#ef4444',
};

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function SyncHistoryChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Sync History</h4>
        <div className="monitor-chart-loading">Loading...</div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Sync History</h4>
        <div className="monitor-chart-empty">No sync data for this period.</div>
      </div>
    );
  }

  const chartData = data.map((entry) => ({
    time: entry.startedAt
      ? new Date(entry.startedAt).toLocaleString()
      : 'Unknown',
    messages: entry.messageCount,
    durationSec: entry.durationMs !== null ? entry.durationMs / 1000 : 0,
    status: entry.status,
    durationMs: entry.durationMs,
    eventsCreated: entry.eventsCreated,
  }));

  return (
    <div className="monitor-chart-card">
      <h4 className="monitor-chart-title">Sync History</h4>
      <div className="monitor-chart-body">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              angle={-30}
              textAnchor="end"
              height={60}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              allowDecimals={false}
              label={{ value: 'Messages', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              label={{ value: 'Duration (s)', angle: 90, position: 'insideRight', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              formatter={(value, name, props) => {
                if (name === 'durationSec') {
                  return [formatDuration((props.payload as { durationMs: number | null }).durationMs), 'Duration'];
                }
                return [value ?? 0, name === 'messages' ? 'Messages' : (name ?? '')];
              }}
              labelFormatter={(label) => `Sync: ${label}`}
            />
            <Legend />
            <Bar yAxisId="left" dataKey="messages" name="Messages" radius={[4, 4, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={STATUS_COLORS[entry.status] || '#6366f1'} />
              ))}
            </Bar>
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="durationSec"
              name="Duration (s)"
              stroke="#6366f1"
              strokeWidth={2}
              dot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
