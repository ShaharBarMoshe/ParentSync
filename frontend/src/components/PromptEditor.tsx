import { useEffect, useState } from 'react';
import { llmPromptApi, llmClassifierPromptApi } from '../services/api';
import type { LlmPrompt } from '../services/api';
import Icon, { type IconName } from './icons/Icon';

type Status =
  | { type: 'idle' }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

export interface PromptEditorProps {
  /** Which prompt to edit. Defaults to 'extractor' to preserve existing call sites. */
  variant?: 'extractor' | 'classifier';
}

interface VariantConfig {
  api: typeof llmPromptApi;
  title: string;
  iconName: IconName;
  hint: string;
}

const VARIANTS: Record<NonNullable<PromptEditorProps['variant']>, VariantConfig> = {
  extractor: {
    api: llmPromptApi,
    title: 'AI Extraction Prompt',
    iconName: 'sparkles',
    hint:
      'Stage 2 of the parsing pipeline. Given a message the classifier flagged as an event, this prompt tells the LLM how to extract the structured fields (title, date, time, location). Edits take effect on the next sync.',
  },
  classifier: {
    api: llmClassifierPromptApi,
    title: 'AI Classifier Prompt',
    iconName: 'list-filter',
    hint:
      'Stage 1 of the parsing pipeline. A short YES/NO prompt that decides whether a message describes an event at all. Most messages are filtered here before reaching the extractor. To loosen what reaches the extractor, edit the YES section; to tighten it, edit the NO section.',
  },
};

export default function PromptEditor({ variant = 'extractor' }: PromptEditorProps) {
  const config = VARIANTS[variant];
  const [prompt, setPrompt] = useState<LlmPrompt | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [showDefault, setShowDefault] = useState(false);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    config.api
      .get()
      .then((p) => {
        setPrompt(p);
        setDraft(p.value);
      })
      .catch((e) =>
        setStatus({ type: 'error', message: `Failed to load prompt: ${e.message}` }),
      );
  }, [config.api]);

  const dirty = prompt !== null && draft !== prompt.value;

  async function handleSave() {
    if (!draft.trim()) {
      setStatus({ type: 'error', message: 'Prompt cannot be empty.' });
      return;
    }
    setBusy(true);
    try {
      const updated = await config.api.save(draft);
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
      const reset = await config.api.reset();
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
        <Icon name={config.iconName} size={16} /> {config.title}
      </h3>
      <p className="settings-section-hint">{config.hint}</p>

      <div className="form-field">
        <textarea
          className="form-input prompt-editor"
          rows={variant === 'classifier' ? 12 : 20}
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
