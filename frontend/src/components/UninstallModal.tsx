import { useEffect, useState } from 'react';
import { systemApi } from '../services/api';
import Icon from './icons/Icon';

interface Props {
  open: boolean;
  removeUserData: boolean;
  onClose: () => void;
}

const CONFIRM_WORD = 'UNINSTALL';

export default function UninstallModal({ open, removeUserData, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ logPath: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setBusy(false);
      setError(null);
      setDone(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await systemApi.uninstall(removeUserData);
      setDone({ logPath: res.logPath });
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to start uninstall');
      setBusy(false);
    }
  }

  return (
    <div className="error-modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="error-modal__header">
          <h2><Icon name="trash-2" size={20} /> Uninstall ParentSync?</h2>
          {!busy && !done && (
            <button className="error-modal__close" onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          )}
        </div>

        {done ? (
          <div className="error-modal__body">
            <p>The cleanup script is now running. The app is about to close.</p>
            <p style={{ marginTop: 12 }}>
              You can verify what was removed in:
            </p>
            <pre className="prompt-default-view" style={{ marginTop: 8 }}>{done.logPath}</pre>
          </div>
        ) : (
          <>
            <div className="error-modal__body">
              <p>
                <strong>This will remove ParentSync and its auto-start entry.</strong>
              </p>
              {removeUserData ? (
                <p>
                  You also chose to remove your <strong>data</strong>: the
                  database, OAuth tokens, WhatsApp Web session, encryption key,
                  and logs. This cannot be undone.
                </p>
              ) : (
                <p>Your data (database, OAuth tokens, WhatsApp session) will stay on disk so a re-install picks up where it left off.</p>
              )}
              <p style={{ marginTop: 16 }}>
                Type <code><strong>{CONFIRM_WORD}</strong></code> below to confirm:
              </p>
              <input
                type="text"
                className="form-input"
                style={{ marginTop: 8, fontFamily: 'monospace' }}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoFocus
                disabled={busy}
              />
              {error && (
                <p style={{ color: 'rgb(220, 38, 38)', marginTop: 12, fontSize: 14 }}>
                  <Icon name="circle-alert" size={14} /> {error}
                </p>
              )}
            </div>

            <div className="error-modal__footer">
              <button
                className="error-modal__btn error-modal__btn--secondary"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="error-modal__btn error-modal__btn--primary"
                onClick={handleConfirm}
                disabled={typed !== CONFIRM_WORD || busy}
                style={{ background: typed === CONFIRM_WORD && !busy ? 'rgb(185, 28, 28)' : undefined }}
              >
                {busy ? <><Icon name="loader" size={16} className="icon-spin" /> Uninstalling…</> : <><Icon name="trash-2" size={16} /> Uninstall</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
