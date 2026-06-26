/** Setting key — see `MessageParserService.buildSystemPrompt()`. */
export const LLM_SYSTEM_PROMPT_KEY = 'llm_system_prompt';

/** `'true'` when the user has explicitly saved a custom prompt; absent or `'false'` means tracking the shipped default. */
export const LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY = 'llm_system_prompt_is_custom';

/** Phase 24 classifier prompt — stage 1 of the two-stage pipeline. */
export const LLM_CLASSIFIER_PROMPT_KEY = 'llm_classifier_prompt';
export const LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY = 'llm_classifier_prompt_is_custom';
/** `'true'` (default) runs the classifier before the extractor; `'false'` reverts to the old single-stage flow. */
export const CLASSIFIER_ENABLED_KEY = 'classifier_enabled';

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
  'calendar_dedup_enabled',
  'calendar_dedup_threshold',
  LLM_SYSTEM_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_KEY,
  CLASSIFIER_ENABLED_KEY,
  'out_of_band_alerts_enabled',
] as const;

/** Keys whose values must never be returned in full via the API. */
export const SENSITIVE_SETTING_KEYS = new Set<string>([]);
