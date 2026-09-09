/**
 * The string a JavaScript object stringifies to. WhatsApp message keys reach us
 * as plain objects when their `_serialized` getter does not survive the
 * puppeteer page boundary; calling `toString()` on one yields this sentinel
 * rather than an id. Rows created before that was caught still hold it.
 */
export const UNUSABLE_APPROVAL_MESSAGE_ID = '[object Object]';

/**
 * True when `id` can safely be used to look up a pending approval.
 *
 * Multiple rows can share the `[object Object]` sentinel, so matching on it
 * resolves to an arbitrary one — in practice the oldest, which silently
 * swallowed reactions meant for a different event. Treat it, and anything
 * blank, as "no id at all".
 */
export function isUsableApprovalMessageId(
  id: string | null | undefined,
): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed !== UNUSABLE_APPROVAL_MESSAGE_ID;
}
