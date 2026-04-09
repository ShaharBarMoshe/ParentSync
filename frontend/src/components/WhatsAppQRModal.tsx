import { useState, useEffect, useCallback, useRef } from 'react';
import { whatsappApi } from '../services/api';
import QRCode from 'qrcode';
import Icon from './icons/Icon';

interface WhatsAppQRModalProps {
  open: boolean;
  onClose: () => void;
}

export default function WhatsAppQRModal({ open, onClose }: WhatsAppQRModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = whatsappApi.getEventsUrl();
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setError(null);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        if (data.type === 'qr') {
          QRCode.toDataURL(data.qr, { width: 256, margin: 2 })
            .then((dataUrl) => setQrDataUrl(dataUrl))
            .catch(() => {});
          setStatus('waiting_for_qr');
        } else if (data.type === 'status') {
          setStatus(data.status);
          if (data.status === 'connected') {
            setQrDataUrl(null);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setError('Lost connection to server. Retrying...');
    };
  }, []);

  useEffect(() => {
    if (open) {
      whatsappApi.getStatus().then((s) => setStatus(s.status)).catch(() => {});
      connectSSE();
    }

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [open, connectSSE]);

  const handleReconnect = async () => {
    setQrDataUrl(null);
    setError(null);
    setStatus('connecting');

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setError('Connection timed out. Please try again.');
      setStatus('disconnected');
    }, 30_000);

    try {
      await whatsappApi.reconnect();
    } catch {
      setError('Failed to connect. Please try again.');
      setStatus('disconnected');
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  };

  if (!open) return null;

  return (
    <div className="qr-modal-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-modal__header">
          <h2>WhatsApp Connection</h2>
          <button className="qr-modal__close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        <div className="qr-modal__body">
          {error && (
            <div className="qr-modal__status qr-modal__status--error">
              <Icon name="circle-alert" size={24} />
              <p>{error}</p>
              <button className="qr-modal__btn qr-modal__btn--secondary" onClick={onClose}>Back to Settings</button>
            </div>
          )}

          {status === 'connected' && (
            <div className="qr-modal__status qr-modal__status--connected">
              <Icon name="circle-check" size={32} className="qr-modal__check" />
              <p>WhatsApp is connected</p>
            </div>
          )}

          {(status === 'connecting' || status === 'authenticated') && (
            <div className="qr-modal__status qr-modal__status--connecting">
              <div className="qr-modal__spinner" />
              <p>{status === 'authenticated' ? 'Authenticated, loading chats...' : 'Connecting to WhatsApp...'}</p>
            </div>
          )}

          {status === 'waiting_for_qr' && qrDataUrl && (
            <div className="qr-modal__qr-section">
              <p>Scan this QR code with WhatsApp on your phone:</p>
              <img src={qrDataUrl} alt="WhatsApp QR Code" className="qr-modal__qr-image" />
              <p className="qr-modal__hint">
                Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
              </p>
            </div>
          )}

          {status === 'disconnected' && (
            <div className="qr-modal__status qr-modal__status--disconnected">
              <Icon name="unlink" size={32} />
              <p>WhatsApp is not connected</p>
            </div>
          )}
        </div>

        <div className="qr-modal__footer">
          {status !== 'connected' && (
            <button
              className="qr-modal__btn qr-modal__btn--primary"
              onClick={handleReconnect}
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? <><Icon name="loader" size={16} className="icon-spin" /> Connecting...</> : <><Icon name="whatsapp" size={16} /> Connect WhatsApp</>}
            </button>
          )}
          {status === 'connected' && (
            <button
              className="qr-modal__btn qr-modal__btn--secondary"
              onClick={handleReconnect}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
