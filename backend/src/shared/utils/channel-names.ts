/**
 * Encoding for `ChildEntity.channelNames`.
 *
 * The field was historically a comma-separated list, which silently corrupts
 * any WhatsApp group whose own name contains a comma — e.g. "בנים שכבת ה', יזמה"
 * was split into two names, neither of which matches a real chat.
 *
 * Newline is the separator now: WhatsApp group names cannot contain one, so
 * the round-trip is lossless. Values written before this change have no
 * newline and are still read as comma-separated, so existing configuration
 * keeps working until it is next saved.
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
