import { useEffect, useState } from 'react';
import { llmPromptApi } from '../services/api';
import type { LlmPrompt } from '../services/api';
import Icon from './icons/Icon';

type Status =
  | { type: 'idle' }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

export default function PromptEditor() {
  const [prompt, setPrompt] = useState<LlmPrompt | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [showDefault, setShowDefault] = useState(false);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    llmPromptApi
      .get()
      .then((p) => {
        setPrompt(p);
        setDraft(p.value);
      })
      .catch((e) =>
        setStatus({ type: 'error', message: `Failed to load prompt: ${e.message}` }),
      );
  }, []);

  const dirty = prompt !== null && draft !== prompt.value;

  async function handleSave() {
    if (!draft.trim()) {
      setStatus({ type: 'error', message: 'Prompt cannot be empty.' });
      return;
    }
    setBusy(true);
    try {
      const updated = await llmPromptApi.save(draft);
      setPrompt(updated);
      setStatus({ type: 'success', message: 'Prompt saved.' });
    } catch (e: any) {
      setStatus({
        type: 'error',
        message: e.response?.data?.message ?? e.message ?? 'Save failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!confirm('Reset the prompt to the default? Your customisations will be lost.')) {
      return;
    }
    setBusy(true);
    try {
      const reset = await llmPromptApi.reset();
      setPrompt(reset);
      setDraft(reset.value);
      setStatus({ type: 'success', message: 'Prompt reset to default.' });
    } catch (e: any) {
      setStatus({
        type: 'error',
        message: e.response?.data?.message ?? e.message ?? 'Reset failed',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">
        <Icon name="sparkles" size={16} /> AI Extraction Prompt
      </h3>
      <p className="settings-section-hint">
        The system prompt the LLM uses to extract events from your messages.
        Edits take effect on the next sync. The default is tuned for Hebrew + English —
        edits may affect accuracy.
      </p>

      <div className="form-field">
        <textarea
          className="form-input prompt-editor"
          rows={20}
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (status.type !== 'idle') setStatus({ type: 'idle' });
          }}
          placeholder="System prompt..."
        />
        {prompt && (
          <span className="form-hint">
            {prompt.isCustom ? 'Currently using a custom prompt.' : 'Currently using the default prompt.'}
            {dirty && ' • Unsaved changes.'}
          </span>
        )}
      </div>

      {status.type === 'success' && (
        <div role="alert" className="settings-alert settings-alert--success">
          {status.message}
          <button
            type="button"
            className="settings-alert__dismiss"
            onClick={() => setStatus({ type: 'idle' })}
            aria-label="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {status.type === 'error' && (
        <div role="alert" className="settings-alert settings-alert--error">
          <Icon name="circle-alert" size={16} />
          {status.message}
          <button
            type="button"
            className="settings-alert__dismiss"
            onClick={() => setStatus({ type: 'idle' })}
            aria-label="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleSave}
          disabled={busy || !dirty}
        >
          <Icon name="save" size={16} /> Save Prompt
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleReset}
          disabled={busy || (prompt !== null && !prompt.isCustom)}
        >
          <Icon name="undo-2" size={16} /> Reset to default
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setShowDefault((v) => !v)}
        >
          <Icon name={showDefault ? 'chevron-up' : 'chevron-down'} size={16} />{' '}
          {showDefault ? 'Hide default' : 'View default'}
        </button>
      </div>

      {showDefault && prompt && (
        <pre className="prompt-default-view">{prompt.default}</pre>
      )}
    </div>
  );
}
