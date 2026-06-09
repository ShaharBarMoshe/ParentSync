import { sha256 } from './hash';

describe('sha256', () => {
  it('is deterministic across calls', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  it('returns a 64-char hex string', () => {
    const hash = sha256('any text');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('matches known SHA-256 of empty string', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
