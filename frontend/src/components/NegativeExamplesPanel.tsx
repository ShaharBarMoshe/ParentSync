import { useCallback, useEffect, useState } from 'react';
import { negativeExamplesApi } from '../services/api';
import type { NegativeExample } from '../services/api';
import Icon from './icons/Icon';

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export default function NegativeExamplesPanel() {
  const [items, setItems] = useState<NegativeExample[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await negativeExamplesApi.list();
      setItems(data.items);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRemove(id: string) {
    setBusy(true);
    try {
      await negativeExamplesApi.remove(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e: any) {
      setError(e.message ?? 'Failed to remove');
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (
      !confirm(
        `Clear all ${items.length} learned exclusions? The AI will lose this feedback and may re-create events you've already rejected.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await negativeExamplesApi.clear();
      setItems([]);
    } catch (e: any) {
      setError(e.message ?? 'Failed to clear');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">
        <Icon name="brain" size={16} /> Learned Exclusions
      </h3>
      <p className="settings-section-hint">
        Messages you've rejected with 😢. The AI sees these on every parse and learns to skip similar messages.
      </p>

      {error && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          {error}
          <button
            type="button"
            className="settings-alert__dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <p className="form-hint">
          <Icon name="loader" size={14} className="icon-spin" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="form-hint">
          No exclusions yet — react with 😢 on an event in the WhatsApp approval channel to teach ParentSync to skip similar messages.
        </p>
      ) : (
        <>
          <p className="form-hint">
            {items.length} message{items.length === 1 ? '' : 's'} the AI has learned to skip.
          </p>
          <ul className="negative-examples-list">
            {items.map((n) => {
              const open = !!expanded[n.id];
              const truncated =
                n.messageContent.length > 200 && !open
                  ? n.messageContent.slice(0, 200) + '…'
                  : n.messageContent;
              return (
                <li key={n.id} className="negative-example-card">
                  <div className="negative-example-card__head">
                    <span className="negative-example-card__channel">
                      {n.channel ?? 'unknown channel'}
                    </span>
                    <span className="negative-example-card__time">
                      {formatRelative(n.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="negative-example-card__remove"
                      onClick={() => handleRemove(n.id)}
                      disabled={busy}
                      aria-label="Remove"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <pre className="negative-example-card__content">{truncated}</pre>
                  {n.messageContent.length > 200 && (
                    <button
                      type="button"
                      className="negative-example-card__expand"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [n.id]: !open }))
                      }
                    >
                      {open ? 'Show less' : 'Show more'}
                    </button>
                  )}
                  <div className="negative-example-card__meta">
                    <Icon name="circle-alert" size={12} /> Wrongly extracted as: <strong>"{n.extractedTitle}"</strong>
                    {n.extractedDate ? <> on {n.extractedDate}</> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleClear}
              disabled={busy}
            >
              <Icon name="trash-2" size={16} /> Clear all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
