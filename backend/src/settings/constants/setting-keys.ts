/** Setting key — see `MessageParserService.buildSystemPrompt()`. */
export const LLM_SYSTEM_PROMPT_KEY = 'llm_system_prompt';

/** All valid setting keys accepted by the Settings API. */
export const ALLOWED_SETTING_KEYS = [
  'check_schedule',
  'gemini_api_key',
  'gemini_model',
  'openrouter_api_key',
  'openrouter_model',
  'google_client_id',
  'google_client_secret',
  'google_redirect_uri',
  'google_calendar_id',
  'approval_channel',
  LLM_SYSTEM_PROMPT_KEY,
] as const;

/** Keys whose values must never be returned in full via the API. */
export const SENSITIVE_SETTING_KEYS = new Set<string>([]);
