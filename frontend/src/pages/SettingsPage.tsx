import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { settingsApi, authApi, childrenApi, whatsappApi, syncApi } from '../services/api';
import type { Setting, AuthStatus, AuthPurpose, AccountStatus, Child } from '../services/api';
import WhatsAppQRModal from '../components/WhatsAppQRModal';
import PromptEditor from '../components/PromptEditor';
import NegativeExamplesPanel from '../components/NegativeExamplesPanel';
import UninstallModal from '../components/UninstallModal';
import Icon from '../components/icons/Icon';

// Google Calendar color palette
const CALENDAR_COLORS: { id: string; name: string; hex: string }[] = [
  { id: '1', name: 'Lavender', hex: '#7986cb' },
  { id: '2', name: 'Sage', hex: '#33b679' },
  { id: '3', name: 'Grape', hex: '#8e24aa' },
  { id: '4', name: 'Flamingo', hex: '#e67c73' },
  { id: '5', name: 'Banana', hex: '#f6bf26' },
  { id: '6', name: 'Tangerine', hex: '#f4511e' },
  { id: '7', name: 'Peacock', hex: '#039be5' },
  { id: '8', name: 'Graphite', hex: '#616161' },
  { id: '9', name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil', hex: '#0b8043' },
  { id: '11', name: 'Tomato', hex: '#d50000' },
];

interface SettingsForm {
  checkSchedule: string;
  geminiApiKey: string;
  geminiModel: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  approvalChannel: string;
}

const SETTING_KEYS = {
  checkSchedule: 'check_schedule',
  geminiApiKey: 'gemini_api_key',
  geminiModel: 'gemini_model',
  googleClientId: 'google_client_id',
  googleClientSecret: 'google_client_secret',
  googleRedirectUri: 'google_redirect_uri',
  approvalChannel: 'approval_channel',
} as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function parseSelectedHours(value: string): Set<number> {
  if (!value.trim()) return new Set<number>();
  return new Set(
    value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 23),
  );
}

function formatSelectedHours(hours: Set<number>): string {
  return [...hours].sort((a, b) => a - b).join(',');
}

function formatHourLabel(h: number): string {
  const suffix = h < 12 ? 'a' : 'p';
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}${suffix}`;
}

function HourPicker({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  const selected = parseSelectedHours(value);
  const [rangeStart, setRangeStart] = useState<number | null>(null);

  function toggle(h: number) {
    const next = new Set(selected);
    if (next.has(h)) {
      next.delete(h);
    } else {
      next.add(h);
    }
    onChange(formatSelectedHours(next));
    setRangeStart(null);
  }

  function handleClick(h: number, e: React.MouseEvent) {
    if (e.shiftKey && rangeStart !== null) {
      const lo = Math.min(rangeStart, h);
      const hi = Math.max(rangeStart, h);
      const next = new Set(selected);
      for (let i = lo; i <= hi; i++) next.add(i);
      onChange(formatSelectedHours(next));
      setRangeStart(null);
    } else {
      toggle(h);
      setRangeStart(h);
    }
  }

  function selectAll() {
    onChange(HOURS.join(','));
  }

  function clearAll() {
    onChange('');
  }

  return (
    <div className="hour-picker">
      <div className="hour-picker__grid" role="group" aria-label="Select sync hours">
        {HOURS.map((h) => (
          <button
            key={h}
            type="button"
            className={`hour-picker__btn ${selected.has(h) ? 'hour-picker__btn--selected' : ''}`}
            onClick={(e) => handleClick(h, e)}
            aria-pressed={selected.has(h)}
            title={`${h}:00`}
          >
            {formatHourLabel(h)}
          </button>
        ))}
      </div>
      <div className="hour-picker__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={selectAll}>All</button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={clearAll}>None</button>
        <span className="hour-picker__count">{selected.size} hour{selected.size !== 1 ? 's' : ''} selected</span>
        <span className="hour-picker__hint">Shift+click to select a range</span>
      </div>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

const DEFAULT_FORM: SettingsForm = {
  checkSchedule: '9,14,18',
  geminiApiKey: '',
  geminiModel: 'gemini-2.0-flash',
  googleClientId: '',
  googleClientSecret: '',
  googleRedirectUri: 'http://localhost:41932/api/auth/google/callback',
  approvalChannel: '',
};

type Status = { type: 'idle' } | { type: 'loading' } | { type: 'saving' } | { type: 'success'; message: string } | { type: 'error'; message: string };

interface ValidationErrors {
  checkSchedule?: string;
}

function validateForm(form: SettingsForm): ValidationErrors {
  const errors: ValidationErrors = {};

  const hours = parseSelectedHours(form.checkSchedule);
  if (hours.size === 0) {
    errors.checkSchedule = 'Select at least one hour';
  }

  return errors;
}

// Google icon SVG
const GOOGLE_ICON = (
  <svg className="btn__icon" viewBox="0 0 24 24" width="18" height="18">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

function GoogleAccountCard({
  purpose, label, description, account, disconnecting, onConnect, onDisconnect,
}: {
  purpose: AuthPurpose; label: string; description: string; account: AccountStatus; disconnecting: boolean;
  onConnect: (purpose: AuthPurpose) => void; onDisconnect: (purpose: AuthPurpose) => void;
}) {
  return (
    <div className="google-account-card">
      <div className="google-account-card__header">
        <h4 className="google-account-card__label">{label}</h4>
        <span className={`google-account-card__status ${account.authenticated ? 'google-account-card__status--connected' : ''}`}>
          {account.authenticated ? <><Icon name="circle-check" size={14} /> Connected</> : <><Icon name="circle-x" size={14} /> Not connected</>}
        </span>
      </div>
      <p className="google-account-card__description">{description}</p>
      {account.authenticated ? (
        <div className="google-account-card__connected">
          <span className="google-account-card__email">{account.email}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => onDisconnect(purpose)} disabled={disconnecting}>
            {disconnecting ? 'Disconnecting...' : <><Icon name="unlink" size={14} /> Disconnect</>}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--google" onClick={() => onConnect(purpose)}>
          {GOOGLE_ICON}
          Sign in with Google
        </button>
      )}
    </div>
  );
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never scanned';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (colorId: string | null) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Calendar color">
      <button
        type="button"
        className={`color-picker__swatch color-picker__swatch--default ${!value ? 'color-picker__swatch--selected' : ''}`}
        onClick={() => onChange(null)}
        aria-label="Default color"
        role="radio"
        aria-checked={!value}
      >
        {!value && <Icon name="check" size={14} className="color-picker__check" />}
      </button>
      {CALENDAR_COLORS.map((color) => (
        <button
          key={color.id}
          type="button"
          className={`color-picker__swatch ${value === color.id ? 'color-picker__swatch--selected' : ''}`}
          style={{ backgroundColor: color.hex }}
          onClick={() => onChange(color.id)}
          aria-label={color.name}
          title={color.name}
          role="radio"
          aria-checked={value === color.id}
        >
          {value === color.id && <Icon name="check" size={14} className="color-picker__check" />}
        </button>
      ))}
    </div>
  );
}

function ChildCard({
  child, onSave, onDelete, saving, onPendingChange,
}: {
  child: Child; onSave: (id: string, data: Partial<Child>) => void; onDelete: (id: string) => void; saving: boolean; onPendingChange?: (id: string, data: Partial<Child> | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(child.name);
  const [channels, setChannels] = useState<string[]>(
    child.channelNames ? child.channelNames.split(',').map((c) => c.trim()).filter(Boolean) : [],
  );
  const [newChannel, setNewChannel] = useState('');
  const [teacherEmails, setTeacherEmails] = useState(child.teacherEmails || '');
  const [calendarColor, setCalendarColor] = useState<string | null>(child.calendarColor);
  const [nameError, setNameError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Reset local state when child prop changes
  useEffect(() => {
    setName(child.name);
    setChannels(child.channelNames ? child.channelNames.split(',').map((c) => c.trim()).filter(Boolean) : []);
    setNewChannel('');
    setTeacherEmails(child.teacherEmails || '');
    setCalendarColor(child.calendarColor);
    setDirty(false);
    onPendingChange?.(child.id, null);
  }, [child]);

  function markDirty() { setDirty(true); }

  function getEditData(): Partial<Child> {
    return {
      name: name.trim(),
      channelNames: channels.length > 0 ? channels.join(', ') : null,
      teacherEmails: teacherEmails.trim() || null,
      calendarColor,
    };
  }

  function saveChannels(updatedChannels: string[]) {
    setChannels(updatedChannels);
    onSave(child.id, {
      channelNames: updatedChannels.length > 0 ? updatedChannels.join(', ') : null,
    });
  }

  // Report pending changes to parent whenever local state changes
  useEffect(() => {
    if (dirty) {
      onPendingChange?.(child.id, getEditData());
    }
  }, [dirty, name, channels, teacherEmails, calendarColor]);

  function handleSave() {
    if (!name.trim()) {
      setNameError('Child name is required');
      return;
    }
    setNameError('');
    onSave(child.id, getEditData());
    setDirty(false);
    onPendingChange?.(child.id, null);
  }

  const colorInfo = CALENDAR_COLORS.find((c) => c.id === calendarColor);

  return (
    <div className="child-card">
      <button
        type="button"
        className="child-card__header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="child-card__header-left">
          {calendarColor && (
            <span
              className="child-card__color-dot"
              style={{ backgroundColor: colorInfo?.hex || '#ccc' }}
              aria-label={`Color: ${colorInfo?.name || 'Unknown'}`}
            />
          )}
          <span className="child-card__name">{child.name}</span>
        </div>
        <div className="child-card__header-right">
          <span className="child-card__scan-time">
            {formatTimeAgo(child.lastScanAt)}
          </span>
          <span className={`child-card__chevron ${expanded ? 'child-card__chevron--open' : ''}`} aria-hidden="true">
            <Icon name="chevron-down" size={16} />
          </span>
        </div>
      </button>

      {expanded && (
        <div className="child-card__body">
          <div className="form-field">
            <label className="form-label" htmlFor={`child-name-${child.id}`}>Child Name</label>
            <input
              id={`child-name-${child.id}`}
              type="text"
              className={`form-input ${nameError ? 'form-input--error' : ''}`}
              value={name}
              onChange={(e) => { setName(e.target.value); markDirty(); setNameError(''); }}
              placeholder="e.g., Yoni"
            />
            {nameError && <span className="form-error">{nameError}</span>}
          </div>

          <div className="form-field">
            <label className="form-label">WhatsApp Channels</label>
            <div className="channel-chips">
              {channels.map((ch) => (
                <span key={ch} className="channel-chips__chip">
                  <span className="channel-chips__text">{ch}</span>
                  <button
                    type="button"
                    className="channel-chips__remove"
                    aria-label={`Remove ${ch}`}
                    onClick={() => { saveChannels(channels.filter((c) => c !== ch)); }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              <div className="channel-chips__add">
                <input
                  id={`child-channels-${child.id}`}
                  type="text"
                  className="form-input channel-chips__input"
                  value={newChannel}
                  onChange={(e) => setNewChannel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const val = newChannel.trim();
                      if (val && !channels.includes(val)) {
                        saveChannels([...channels, val]);
                        setNewChannel('');
                      }
                    }
                  }}
                  placeholder="Type channel name and press Enter"
                />
                <button
                  type="button"
                  className="btn btn--sm channel-chips__add-btn"
                  onClick={() => {
                    const val = newChannel.trim();
                    if (val && !channels.includes(val)) {
                      saveChannels([...channels, val]);
                      setNewChannel('');
                    }
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor={`child-emails-${child.id}`}>Teacher Emails</label>
            <input
              id={`child-emails-${child.id}`}
              type="text"
              className="form-input"
              value={teacherEmails}
              onChange={(e) => { setTeacherEmails(e.target.value); markDirty(); }}
              placeholder="e.g., teacher@school.edu"
            />
            <span className="form-hint">Comma-separated email addresses (leave empty if none)</span>
          </div>

          <div className="form-field">
            <label className="form-label">Calendar Color</label>
            <ColorPicker value={calendarColor} onChange={(id) => { setCalendarColor(id); markDirty(); }} />
          </div>

          <div className="child-card__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm child-card__delete-btn"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Icon name="trash-2" size={14} /> Remove
            </button>
          </div>

          {showDeleteConfirm && (
            <div className="child-card__confirm" role="alertdialog" aria-label={`Remove ${child.name}?`}>
              <p>Remove <strong>{child.name}</strong>?</p>
              <div className="child-card__confirm-actions">
                <button type="button" className="btn btn--primary btn--sm child-card__confirm-remove" onClick={() => { onDelete(child.id); setShowDeleteConfirm(false); }}>
                  Remove
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChildList({
  children, onSave, onDelete, onAdd, saving, onPendingChange,
}: {
  children: Child[]; onSave: (id: string, data: Partial<Child>) => void; onDelete: (id: string) => void; onAdd: () => void; saving: boolean; onPendingChange?: (id: string, data: Partial<Child> | null) => void;
}) {
  if (children.length === 0) {
    return (
      <div className="child-list__empty">
        <p>Add your first child to get started</p>
        <button type="button" className="btn btn--primary" onClick={onAdd}>
          <Icon name="plus" size={16} /> Add Child
        </button>
      </div>
    );
  }

  return (
    <div className="child-list">
      {children.map((child) => (
        <ChildCard key={child.id} child={child} onSave={onSave} onDelete={onDelete} saving={saving} onPendingChange={onPendingChange} />
      ))}
      <button type="button" className="btn btn--secondary child-list__add-btn" onClick={onAdd}>
        <Icon name="plus" size={16} /> Add Child
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [form, setForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [savedForm, setSavedForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallPurge, setUninstallPurge] = useState(false);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    gmail: { authenticated: false },
    calendar: { authenticated: false },
  });
  const [disconnectingPurpose, setDisconnectingPurpose] = useState<AuthPurpose | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [childSaving, setChildSaving] = useState(false);
  const pendingChildEdits = useRef<Map<string, Partial<Child>>>(new Map());
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [whatsappQROpen, setWhatsappQROpen] = useState(false);

  useEffect(() => {
    loadSettings();
    loadAuthStatus();
    loadChildren();
    loadWhatsAppStatus();
    handleAuthRedirect();
  }, []);

  function handleAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('auth');
    const purpose = params.get('purpose');
    if (authResult === 'success') {
      const label = purpose === 'calendar' ? 'Calendar' : 'Gmail';
      setStatus({ type: 'success', message: `${label} account connected successfully` });
      loadAuthStatus();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (authResult === 'error') {
      const message = params.get('message') || 'Failed to connect Google account';
      setStatus({ type: 'error', message });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  async function loadWhatsAppStatus() {
    try {
      const data = await whatsappApi.getStatus();
      setWhatsappConnected(data.connected);
    } catch {
      // Silently fail
    }
  }

  async function loadAuthStatus() {
    try {
      const status = await authApi.getStatus();
      setAuthStatus(status);
    } catch {
      // Silently fail
    }
  }

  async function loadSettings() {
    setStatus({ type: 'loading' });
    try {
      const settings = await settingsApi.getAll();
      const loaded = settingsToForm(settings);
      setForm(loaded);
      setSavedForm(loaded);
      setStatus({ type: 'idle' });
    } catch (err) {
      console.error('Failed to load settings:', err);
      setStatus({ type: 'error', message: 'Failed to load settings' });
    }
  }

  async function loadChildren() {
    try {
      const data = await childrenApi.getAll();
      setChildren(data);
    } catch {
      // Children will show empty state
    }
  }

  function settingsToForm(settings: Setting[]): SettingsForm {
    const map = new Map(settings.map((s) => [s.key, s.value]));
    return {
      checkSchedule: map.get(SETTING_KEYS.checkSchedule) ?? DEFAULT_FORM.checkSchedule,
      geminiApiKey: map.get(SETTING_KEYS.geminiApiKey) ?? DEFAULT_FORM.geminiApiKey,
      geminiModel: map.get(SETTING_KEYS.geminiModel) ?? DEFAULT_FORM.geminiModel,
      googleClientId: map.get(SETTING_KEYS.googleClientId) ?? DEFAULT_FORM.googleClientId,
      googleClientSecret: map.get(SETTING_KEYS.googleClientSecret) ?? DEFAULT_FORM.googleClientSecret,
      googleRedirectUri: map.get(SETTING_KEYS.googleRedirectUri) ?? DEFAULT_FORM.googleRedirectUri,
      approvalChannel: map.get(SETTING_KEYS.approvalChannel) ?? DEFAULT_FORM.approvalChannel,
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validationErrors = validateForm(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setStatus({ type: 'saving' });
    try {
      // Save any dirty child changes first
      const pendingEdits = Array.from(pendingChildEdits.current.entries());
      for (const [childId, data] of pendingEdits) {
        if (data.name && !data.name.trim()) continue; // skip invalid
        const updated = await childrenApi.update(childId, data as any);
        setChildren((prev) => prev.map((c) => (c.id === childId ? updated : c)));
      }
      pendingChildEdits.current.clear();

      // Save settings (skip empty optional fields)
      const entries = Object.entries(SETTING_KEYS) as [keyof SettingsForm, string][];
      for (const [formKey, settingKey] of entries) {
        const value = form[formKey];
        if (value) {
          await settingsApi.create(settingKey, value);
        } else {
          // Delete the setting if it was previously saved but is now empty
          try { await settingsApi.delete(settingKey); } catch { /* ignore if not found */ }
        }
      }
      setSavedForm(form);
      setStatus({ type: 'success', message: 'Settings saved successfully' });
    } catch {
      setStatus({ type: 'error', message: 'Failed to save settings' });
    }
  }

  function handleReset() {
    setForm(savedForm);
    setErrors({});
    setStatus({ type: 'idle' });
  }

  function handleConnect(purpose: AuthPurpose) {
    window.location.href = authApi.getConnectUrl(purpose);
  }

  async function handleDisconnect(purpose: AuthPurpose) {
    setDisconnectingPurpose(purpose);
    try {
      await authApi.disconnect(purpose);
      setAuthStatus((prev) => ({ ...prev, [purpose]: { authenticated: false } }));
      const label = purpose === 'calendar' ? 'Calendar' : 'Gmail';
      setStatus({ type: 'success', message: `${label} account disconnected` });
    } catch {
      setStatus({ type: 'error', message: 'Failed to disconnect account' });
    } finally {
      setDisconnectingPurpose(null);
    }
  }

  function handleChange(field: keyof SettingsForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof ValidationErrors]) {
      setErrors((prev) => { const next = { ...prev }; delete next[field as keyof ValidationErrors]; return next; });
    }
  }

  const handleChildPendingChange = useCallback((id: string, data: Partial<Child> | null) => {
    if (data) {
      pendingChildEdits.current.set(id, data);
    } else {
      pendingChildEdits.current.delete(id);
    }
  }, []);

  const handleAddChild = useCallback(async () => {
    setChildSaving(true);
    try {
      const newChild = await childrenApi.create({ name: 'New Child' });
      setChildren((prev) => [...prev, newChild]);
    } catch {
      setStatus({ type: 'error', message: 'Failed to add child' });
    } finally {
      setChildSaving(false);
    }
  }, []);

  const handleSaveChild = useCallback(async (id: string, data: Partial<Child>) => {
    setChildSaving(true);
    try {
      const updated = await childrenApi.update(id, data as any);
      setChildren((prev) => prev.map((c) => (c.id === id ? updated : c)));
      setStatus({ type: 'success', message: 'Child saved' });
    } catch {
      setStatus({ type: 'error', message: 'Failed to save child' });
    } finally {
      setChildSaving(false);
    }
  }, []);

  const handleDeleteChild = useCallback(async (id: string) => {
    setChildSaving(true);
    try {
      await childrenApi.delete(id);
      setChildren((prev) => prev.filter((c) => c.id !== id));
      setStatus({ type: 'success', message: 'Child removed' });
    } catch {
      setStatus({ type: 'error', message: 'Failed to remove child' });
    } finally {
      setChildSaving(false);
    }
  }, []);

  const [resetting, setResetting] = useState(false);

  const handleResetSync = useCallback(async () => {
    setResetting(true);
    try {
      const result = await syncApi.resetSyncState();
      await loadChildren();
      setStatus({
        type: 'success',
        message: `Sync state reset: ${result.childrenReset} children, ${result.messagesReset} messages marked for re-evaluation`,
      });
    } catch {
      setStatus({ type: 'error', message: 'Failed to reset sync state' });
    } finally {
      setResetting(false);
    }
  }, []);

  const isLoading = status.type === 'loading';
  const isSaving = status.type === 'saving';

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Settings</h1>
        <p>Configure your children, sync schedule, and integrations.</p>
      </div>

      {status.type === 'success' && (
        <div role="alert" className="settings-alert settings-alert--success">
          <Icon name="circle-check" size={16} />
          <span>{status.message}</span>
          <button type="button" className="settings-alert__dismiss" onClick={() => setStatus({ type: 'idle' })} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}
      {status.type === 'error' && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          <span>{status.message}</span>
          <button type="button" className="settings-alert__dismiss" onClick={() => setStatus({ type: 'idle' })} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}

      {isLoading ? (
        <div className="settings-loading">
          <div className="settings-loading-spinner" />
          <p>Loading settings...</p>
        </div>
      ) : (
        <>
          {/* WhatsApp Connection */}
          <div className="settings-section">
            <h3 className="settings-section-title"><Icon name="whatsapp" size={16} /> WhatsApp</h3>
            <div className="google-account-card">
              <div className="google-account-card__header">
                <h4 className="google-account-card__label">WhatsApp Web</h4>
                <span className={`google-account-card__status ${whatsappConnected ? 'google-account-card__status--connected' : ''}`}>
                  {whatsappConnected ? <><Icon name="circle-check" size={14} /> Connected</> : <><Icon name="circle-x" size={14} /> Not connected</>}
                </span>
              </div>
              <p className="google-account-card__description">Connect to WhatsApp Web to scan messages from parent group channels.</p>
              <button type="button" className="btn btn--primary" onClick={() => setWhatsappQROpen(true)}>
                <Icon name={whatsappConnected ? 'link' : 'whatsapp'} size={16} /> {whatsappConnected ? 'Manage Connection' : 'Connect WhatsApp'}
              </button>
            </div>
          </div>

          <WhatsAppQRModal open={whatsappQROpen} onClose={() => { setWhatsappQROpen(false); loadWhatsAppStatus(); }} />

          {/* Google Accounts */}
          <div className="settings-section">
            <h3 className="settings-section-title"><Icon name="mail" size={16} /> Google Accounts</h3>
            <p className="settings-section-hint">
              Connect separate Google accounts for email scanning and calendar management, or use the same account for both.
            </p>
            <div className="google-accounts-grid">
              <GoogleAccountCard purpose="gmail" label="Email Scanning" description="Used to read emails from teachers and school contacts." account={authStatus.gmail} disconnecting={disconnectingPurpose === 'gmail'} onConnect={handleConnect} onDisconnect={handleDisconnect} />
              <GoogleAccountCard purpose="calendar" label="Calendar" description="Used to create and manage events on your family calendar." account={authStatus.calendar} disconnecting={disconnectingPurpose === 'calendar'} onConnect={handleConnect} onDisconnect={handleDisconnect} />
            </div>
          </div>

          {/* Children */}
          <div className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3 className="settings-section-title"><Icon name="users" size={16} /> Children</h3>
                <p className="settings-section-hint">
                  Add your children and configure their WhatsApp channels, teacher emails, and calendar colors.
                </p>
              </div>
              {children.length > 0 && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={handleResetSync}
                  disabled={resetting}
                  title="Reset scan timestamps and re-parse all messages on next sync"
                >
                  {resetting
                    ? <><Icon name="loader" size={14} className="icon-spin" /> Resetting...</>
                    : <><Icon name="refresh-cw" size={14} /> Reset Sync State</>}
                </button>
              )}
            </div>
            <ChildList children={children} onSave={handleSaveChild} onDelete={handleDeleteChild} onAdd={handleAddChild} saving={childSaving} onPendingChange={handleChildPendingChange} />
          </div>

          {/* Settings Form */}
          <form onSubmit={handleSubmit}>
            {/* Gemini */}
            <div className="settings-section">
              <h3 className="settings-section-title"><Icon name="key-round" size={16} /> Gemini AI</h3>
              <div className="form-field">
                <label htmlFor="geminiApiKey" className="form-label">API Key</label>
                <input id="geminiApiKey" type="text" className="form-input" value={form.geminiApiKey} onChange={(e) => handleChange('geminiApiKey', e.target.value)} placeholder="AIza..." autoComplete="off" data-lpignore="true" data-1p-ignore="true" />
                <span className="form-hint">Your Gemini API key. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get one here</a> (free)</span>
              </div>
              <div className="form-field">
                <label htmlFor="geminiModel" className="form-label">Model</label>
                <input id="geminiModel" type="text" className="form-input" value={form.geminiModel} onChange={(e) => handleChange('geminiModel', e.target.value)} placeholder="gemini-2.0-flash" />
                <span className="form-hint">Gemini model (e.g., gemini-2.0-flash, gemini-2.5-flash-preview-05-20)</span>
              </div>
            </div>

            {/* Google OAuth */}
            <div className="settings-section">
              <h3 className="settings-section-title"><Icon name="external-link" size={16} /> Google OAuth</h3>
              <div className="form-field">
                <label htmlFor="googleClientId" className="form-label">Client ID</label>
                <input id="googleClientId" type="text" className="form-input" value={form.googleClientId} onChange={(e) => handleChange('googleClientId', e.target.value)} placeholder="123456789-abc.apps.googleusercontent.com" />
                <span className="form-hint">From <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> &rarr; APIs &amp; Services &rarr; Credentials</span>
              </div>
              <div className="form-field">
                <label htmlFor="googleClientSecret" className="form-label">Client Secret</label>
                <input id="googleClientSecret" type="text" className="form-input" value={form.googleClientSecret} onChange={(e) => handleChange('googleClientSecret', e.target.value)} placeholder="GOCSPX-..." autoComplete="off" data-lpignore="true" data-1p-ignore="true" />
              </div>
              <div className="form-field">
                <label htmlFor="googleRedirectUri" className="form-label">Redirect URI</label>
                <input id="googleRedirectUri" type="text" className="form-input" value={form.googleRedirectUri} onChange={(e) => handleChange('googleRedirectUri', e.target.value)} placeholder="http://localhost:41932/api/auth/google/callback" />
                <span className="form-hint">Must match the redirect URI configured in Google Cloud Console</span>
              </div>
            </div>

            {/* Sync Schedule */}
            <div className="settings-section">
              <h3 className="settings-section-title"><Icon name="clock" size={16} /> Sync Schedule</h3>
              <div className="form-field">
                <label className="form-label">Check Schedule</label>
                <HourPicker value={form.checkSchedule} onChange={(v) => handleChange('checkSchedule', v)} error={errors.checkSchedule} />
              </div>
            </div>

            {/* Event Approval */}
            <div className="settings-section">
              <h3 className="settings-section-title"><Icon name="calendar-check" size={16} /> Event Approval</h3>
              <div className="form-field">
                <label htmlFor="approvalChannel" className="form-label">Approval Channel</label>
                <input id="approvalChannel" type="text" className="form-input" value={form.approvalChannel} onChange={(e) => handleChange('approvalChannel', e.target.value)} placeholder="e.g., Family Calendar Approvals" />
                <span className="form-hint">WhatsApp group name for approving events before they sync to Google Calendar. Leave empty to auto-sync without approval.</span>
              </div>
            </div>

            {/* AI Extraction Prompt */}
            <PromptEditor />

            {/* Learned Exclusions (negative-reaction feedback) */}
            <NegativeExamplesPanel />

            <div className="settings-actions">
              <button type="submit" disabled={isSaving} className="btn btn--primary">
                {isSaving ? <><Icon name="loader" size={16} className="icon-spin" /> Saving...</> : <><Icon name="save" size={16} /> Save Settings</>}
              </button>
              <button type="button" onClick={handleReset} disabled={isSaving} className="btn btn--secondary">
                <Icon name="undo-2" size={16} /> Reset
              </button>
            </div>
          </form>

          <div className="settings-section danger-zone">
            <h3 className="settings-section-title">
              <Icon name="triangle-alert" size={16} /> Danger Zone
            </h3>
            <p className="settings-section-hint">
              Uninstall ParentSync from this machine. The app and its
              auto-start entry are removed; your data is removed only if you
              tick the box. The cleanup script logs every step to a file you
              can verify after the app closes.
            </p>
            <label className="form-checkbox" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={uninstallPurge}
                onChange={(e) => setUninstallPurge(e.target.checked)}
              />
              <span>Also remove my data (database, OAuth tokens, WhatsApp session, encryption key, logs)</span>
            </label>
            <div className="settings-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => setUninstallOpen(true)}
              >
                <Icon name="trash-2" size={16} /> Uninstall ParentSync
              </button>
            </div>
          </div>

          <UninstallModal
            open={uninstallOpen}
            removeUserData={uninstallPurge}
            onClose={() => setUninstallOpen(false)}
          />
        </>
      )}
    </div>
  );
}
