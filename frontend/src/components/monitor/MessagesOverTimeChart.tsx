import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import type { ChartResponse } from '../../services/api';

interface Props {
  data: ChartResponse | null;
  loading: boolean;
}

export default function MessagesOverTimeChart({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Messages Over Time</h4>
        <div className="monitor-chart-loading">Loading...</div>
      </div>
    );
  }

  if (!data || data.labels.length === 0) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Messages Over Time</h4>
        <div className="monitor-chart-empty">No message data for this period.</div>
      </div>
    );
  }

  const chartData = data.labels.map((label, i) => ({
    date: label,
    WhatsApp: data.datasets[0]?.data[i] || 0,
    Email: data.datasets[1]?.data[i] || 0,
  }));

  return (
    <div className="monitor-chart-card">
      <h4 className="monitor-chart-title">Messages Over Time</h4>
      <div className="monitor-chart-body">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              tickFormatter={(v) => {
                const d = new Date(v + 'T00:00:00');
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
            />
            <YAxis
              tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="WhatsApp"
              stroke="#25d366"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="Email"
              stroke="#ea4335"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
