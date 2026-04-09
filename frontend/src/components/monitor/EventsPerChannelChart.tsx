import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { ChartResponse } from '../../services/api';

interface Props {
  data: ChartResponse | null;
  loading: boolean;
}

const COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd',
  '#818cf8', '#7c3aed', '#5b21b6', '#4f46e5',
  '#4338ca', '#3730a3',
];

export default function EventsPerChannelChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Events Per Channel</h4>
        <div className="monitor-chart-loading">Loading...</div>
      </div>
    );
  }

  if (!data || data.labels.length === 0) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Events Per Channel</h4>
        <div className="monitor-chart-empty">No event data for this period.</div>
      </div>
    );
  }

  const chartData = data.labels.map((label, i) => ({
    channel: label,
    events: data.datasets[0]?.data[i] || 0,
  }));

  const totalEvents = chartData.reduce((sum, d) => sum + d.events, 0);
  const height = Math.max(200, chartData.length * 40);

  return (
    <div className="monitor-chart-card">
      <h4 className="monitor-chart-title">Events Per Channel</h4>
      <div className="monitor-chart-body">
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              allowDecimals={false}
            />
            <YAxis
              dataKey="channel"
              type="category"
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              width={140}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              formatter={(value) => [
                `${value} (${totalEvents > 0 ? Math.round((Number(value) / totalEvents) * 100) : 0}%)`,
                'Events',
              ]}
            />
            <Bar dataKey="events" radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
