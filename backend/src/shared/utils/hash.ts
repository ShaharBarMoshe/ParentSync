import { createHash } from 'crypto';

/** Hex-encoded SHA-256 of the input. Used for content-identity short-circuits. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
