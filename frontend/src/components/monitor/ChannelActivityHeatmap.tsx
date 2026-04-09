import { useState } from 'react';
import type { HeatmapData } from '../../services/api';

interface Props {
  data: HeatmapData | null;
  loading: boolean;
}

function getColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'var(--border)';
  const intensity = value / max;
  if (intensity > 0.75) return 'var(--accent)';
  if (intensity > 0.5) return 'rgba(99, 102, 241, 0.6)';
  if (intensity > 0.25) return 'rgba(99, 102, 241, 0.35)';
  return 'rgba(99, 102, 241, 0.15)';
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ChannelActivityHeatmap({ data, loading }: Props) {
  const [tooltip, setTooltip] = useState<{
    channel: string;
    date: string;
    count: number;
    x: number;
    y: number;
  } | null>(null);

  if (loading) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Channel Activity</h4>
        <div className="monitor-chart-loading">Loading...</div>
      </div>
    );
  }

  if (!data || data.channels.length === 0) {
    return (
      <div className="monitor-chart-card">
        <h4 className="monitor-chart-title">Channel Activity</h4>
        <div className="monitor-chart-empty">No channel activity data for this period.</div>
      </div>
    );
  }

  const maxValue = Math.max(...data.data.flat(), 1);

  return (
    <div className="monitor-chart-card">
      <h4 className="monitor-chart-title">Channel Activity</h4>
      <div className="monitor-chart-body monitor-heatmap-wrapper">
        <div className="monitor-heatmap">
          {/* Column headers (dates) */}
          <div className="monitor-heatmap-row monitor-heatmap-header">
            <div className="monitor-heatmap-label" />
            {data.dates.map((date) => (
              <div key={date} className="monitor-heatmap-col-label">
                {formatDate(date)}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {data.channels.map((channel, rowIdx) => (
            <div key={channel} className="monitor-heatmap-row">
              <div className="monitor-heatmap-label" title={channel}>
                {channel}
              </div>
              {data.dates.map((date, colIdx) => {
                const count = data.data[rowIdx][colIdx];
                return (
                  <div
                    key={date}
                    className="monitor-heatmap-cell"
                    style={{ background: getColor(count, maxValue) }}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({
                        channel,
                        date,
                        count,
                        x: rect.left + rect.width / 2,
                        y: rect.top - 8,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}

          {/* Legend */}
          <div className="monitor-heatmap-legend">
            <span>Less</span>
            <div className="monitor-heatmap-cell" style={{ background: 'var(--border)' }} />
            <div className="monitor-heatmap-cell" style={{ background: 'rgba(99, 102, 241, 0.15)' }} />
            <div className="monitor-heatmap-cell" style={{ background: 'rgba(99, 102, 241, 0.35)' }} />
            <div className="monitor-heatmap-cell" style={{ background: 'rgba(99, 102, 241, 0.6)' }} />
            <div className="monitor-heatmap-cell" style={{ background: 'var(--accent)' }} />
            <span>More</span>
          </div>
        </div>

        {tooltip && (
          <div
            className="monitor-heatmap-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <strong>{tooltip.channel}</strong>
            <br />
            {tooltip.date}: {tooltip.count} messages
          </div>
        )}
      </div>
    </div>
  );
}
