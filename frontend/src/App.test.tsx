import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all page components to avoid their API calls
vi.mock('./pages/DashboardPage', () => ({
  default: () => <div data-testid="dashboard-page">dash-stub</div>,
}));
vi.mock('./pages/CalendarPage', () => ({
  default: () => <div data-testid="calendar-page">cal-stub</div>,
}));
vi.mock('./pages/MonitorPage', () => ({
  default: () => <div data-testid="monitor-page">mon-stub</div>,
}));
vi.mock('./pages/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">set-stub</div>,
}));

import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders navbar with all navigation links', () => {
    render(<App />);
    expect(screen.getByText('ParentSync')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Monitor' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /refresh all data/i })).toBeInTheDocument();
  });

  it('renders dashboard page by default', () => {
    render(<App />);
    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
  });

  it('adds spinning class on refresh click and removes it after timeout', () => {
    vi.useFakeTimers();
    render(<App />);

    const btn = screen.getByRole('button', { name: /refresh all data/i });
    expect(btn.className).not.toContain('spinning');

    act(() => { fireEvent.click(btn); });
    expect(btn.className).toContain('app-nav-refresh--spinning');

    act(() => { vi.advanceTimersByTime(600); });
    expect(btn.className).not.toContain('spinning');

    vi.useRealTimers();
  });

  it('remounts page content on refresh click', () => {
    render(<App />);
    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: /refresh all data/i });
    act(() => { fireEvent.click(btn); });

    // Page is still rendered after remount
    expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
  });

  it('renders footer', () => {
    render(<App />);
    expect(screen.getByText('ParentSync v1.0')).toBeInTheDocument();
  });
});
