/**
 * Encoding for a child's `channelNames` field. Mirrors
 * `backend/src/shared/utils/channel-names.ts` — keep the two in sync.
 *
 * Newline-separated, because WhatsApp group names may contain a comma (e.g.
 * "בנים שכבת ה', יזמה") and the old comma encoding split those into two names
 * that matched no real chat. Legacy comma-encoded values are still read.
 */

/** Split a stored `channelNames` value into individual channel names. */
export function parseChannelNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const separator = raw.includes('\n') ? '\n' : ',';
  return raw
    .split(separator)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Encode a list of channel names for storage. */
export function serializeChannelNames(names: string[]): string {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .join('\n');
}
