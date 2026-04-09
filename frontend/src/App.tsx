import { useState, useCallback } from 'react';
import { HashRouter, BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Icon from './components/icons/Icon';
import DashboardPage from './pages/DashboardPage';
import CalendarPage from './pages/CalendarPage';
import SettingsPage from './pages/SettingsPage';
import MonitorPage from './pages/MonitorPage';

const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;
const Router = isElectron ? HashRouter : BrowserRouter;

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [spinning, setSpinning] = useState(false);

  const handleRefresh = useCallback(() => {
    setSpinning(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setSpinning(false), 600);
  }, []);

  return (
    <Router>
      <div className="app-layout">
        <nav className="app-nav">
          <span className="app-nav-brand">ParentSync</span>
          <div className="app-nav-links">
            <NavLink to="/" end className={({ isActive }) => `app-nav-link ${isActive ? 'app-nav-link--active' : ''}`}>
              <Icon name="layout-dashboard" size={16} /> Dashboard
            </NavLink>
            <NavLink to="/calendar" className={({ isActive }) => `app-nav-link ${isActive ? 'app-nav-link--active' : ''}`}>
              <Icon name="calendar" size={16} /> Calendar
            </NavLink>
            <NavLink to="/monitor" className={({ isActive }) => `app-nav-link ${isActive ? 'app-nav-link--active' : ''}`}>
              <Icon name="chart-line" size={16} /> Monitor
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => `app-nav-link ${isActive ? 'app-nav-link--active' : ''}`}>
              <Icon name="settings" size={16} /> Settings
            </NavLink>
          </div>
          <button
            className={`app-nav-refresh${spinning ? ' app-nav-refresh--spinning' : ''}`}
            onClick={handleRefresh}
            title="Refresh all data"
            aria-label="Refresh all data"
          >
            <Icon name="refresh-cw" size={16} />
          </button>
        </nav>
        <main className="app-main" key={refreshKey}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/monitor" element={<MonitorPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
        <footer className="app-footer">
          <span>ParentSync v1.0</span>
        </footer>
      </div>
    </Router>
  );
}

export default App;
