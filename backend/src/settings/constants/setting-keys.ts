/** Setting key — see `MessageParserService.buildSystemPrompt()`. */
export const LLM_SYSTEM_PROMPT_KEY = 'llm_system_prompt';

/** `'true'` when the user has explicitly saved a custom prompt; absent or `'false'` means tracking the shipped default. */
export const LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY = 'llm_system_prompt_is_custom';

/** Phase 24 classifier prompt — stage 1 of the two-stage pipeline. */
export const LLM_CLASSIFIER_PROMPT_KEY = 'llm_classifier_prompt';
export const LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY = 'llm_classifier_prompt_is_custom';
/** `'true'` (default) runs the classifier before the extractor; `'false'` reverts to the old single-stage flow. */
export const CLASSIFIER_ENABLED_KEY = 'classifier_enabled';

/**
 * LangSmith observability. Off by default: this app processes children's
 * school messages, and tracing uploads them to smith.langchain.com. Nothing
 * leaves the machine unless `langsmith_enabled` is explicitly turned on.
 */
export const LANGSMITH_ENABLED_KEY = 'langsmith_enabled';
export const LANGSMITH_API_KEY = 'langsmith_api_key';
export const LANGSMITH_PROJECT_KEY = 'langsmith_project';
/** `'true'` (default) replaces message bodies with a hash before upload. */
export const LANGSMITH_REDACT_KEY = 'langsmith_redact';

/** Every setting the tracer reads; a change to any rebuilds it. */
export const LANGSMITH_SETTING_KEYS = [
  LANGSMITH_ENABLED_KEY,
  LANGSMITH_API_KEY,
  LANGSMITH_PROJECT_KEY,
  LANGSMITH_REDACT_KEY,
] as const;

/**
 * Selects the LLM/embedding adapter implementation: `'langchain'` (default) or
 * `'legacy'` for the pre-migration Gemini SDK adapters. Temporary escape hatch
 * for the Phase 26 migration — remove once LangChain has run a few weeks of
 * daily syncs without incident.
 */
export const LLM_RUNTIME_KEY = 'llm_runtime';

/** All valid setting keys accepted by the Settings API. */
export const ALLOWED_SETTING_KEYS = [
  'check_schedule',
  'gemini_api_key',
  'gemini_model',
'google_client_id',
  'google_client_secret',
  'google_redirect_uri',
  'google_calendar_id',
  'approval_channel',
  'dedup_enabled',
  'dedup_threshold',
  'calendar_dedup_enabled',
  'calendar_dedup_threshold',
  LLM_SYSTEM_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_KEY,
  CLASSIFIER_ENABLED_KEY,
  'out_of_band_alerts_enabled',
  'smoke_test_enabled',
  LANGSMITH_ENABLED_KEY,
  LANGSMITH_API_KEY,
  LANGSMITH_PROJECT_KEY,
  LANGSMITH_REDACT_KEY,
  LLM_RUNTIME_KEY,
] as const;

/** Keys whose values must never be returned in full via the API. */
export const SENSITIVE_SETTING_KEYS = new Set<string>([]);
