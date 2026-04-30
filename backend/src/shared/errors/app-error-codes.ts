export const AppErrorCodes = {
  // OAuth (Google sign-in / refresh)
  OAUTH_NO_REFRESH_TOKEN: 'OAUTH_NO_REFRESH_TOKEN',
  OAUTH_REFRESH_FAILED: 'OAUTH_REFRESH_FAILED',

  // Google Calendar / Tasks event push
  EVENT_SYNC_GOOGLE_FAILED: 'EVENT_SYNC_GOOGLE_FAILED',

  // WhatsApp Web client
  WHATSAPP_INIT_FAILED: 'WHATSAPP_INIT_FAILED',
  WHATSAPP_CHANNEL_NOT_FOUND: 'WHATSAPP_CHANNEL_NOT_FOUND',
  WHATSAPP_FETCH_FAILED: 'WHATSAPP_FETCH_FAILED',
  WHATSAPP_SEND_FAILED: 'WHATSAPP_SEND_FAILED',

  // Sync downstream (approval / reminders)
  APPROVAL_WHATSAPP_DISCONNECTED: 'APPROVAL_WHATSAPP_DISCONNECTED',
  REMINDER_SEND_FAILED: 'REMINDER_SEND_FAILED',

  // Crypto / settings
  CRYPTO_DECRYPT_FAILED: 'CRYPTO_DECRYPT_FAILED',

  // LLM (in addition to per-status codes from OpenRouter / Gemini)
  LLM_ALL_PROVIDERS_FAILED: 'LLM_ALL_PROVIDERS_FAILED',
} as const;

export type AppErrorCode = (typeof AppErrorCodes)[keyof typeof AppErrorCodes];
