import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { syncApi } from '../services/api';
import Icon from './icons/Icon';

interface AppError {
  source: string;
  code: string;
  message: string;
  timestamp: string;
}

export default function ErrorModal() {
  const [error, setError] = useState<AppError | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const navigate = useNavigate();

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = syncApi.getErrorsUrl();
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: AppError = JSON.parse(event.data);
        // Don't show the same error code again if already dismissed
        if (data.code !== dismissed) {
          setError(data);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // Silently reconnect — EventSource handles this automatically
    };
  }, [dismissed]);

  useEffect(() => {
    connectSSE();

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connectSSE]);

  const handleDismiss = () => {
    if (error) {
      setDismissed(error.code);
    }
    setError(null);
  };

  const handleGoToSettings = () => {
    setError(null);
    navigate('/settings');
  };

  if (!error) return null;

  return (
    <div className="error-modal-overlay" onClick={handleDismiss}>
      <div className="error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="error-modal__header">
          <h2><Icon name="circle-alert" size={20} /> Error</h2>
          <button className="error-modal__close" onClick={handleDismiss}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="error-modal__body">
          <p>{error.message}</p>
          <span className="error-modal__code">{error.code}</span>
        </div>

        <div className="error-modal__footer">
          <button className="error-modal__btn error-modal__btn--primary" onClick={handleGoToSettings}>
            <Icon name="settings" size={16} /> Go to Settings
          </button>
          <button className="error-modal__btn error-modal__btn--secondary" onClick={handleDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
