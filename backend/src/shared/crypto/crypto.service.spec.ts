import * as fs from 'fs';
import * as crypto from 'crypto';
import { CryptoService } from './crypto.service';

// Mock the fs module before any imports use it
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const mockedFs = jest.mocked(fs);

describe('CryptoService', () => {
  const fakeKeyHex = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createServiceWithExistingKey(): CryptoService {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(fakeKeyHex);
    return new CryptoService();
  }

  describe('loadOrCreateKey', () => {
    it('should read existing key file when it exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(fakeKeyHex);

      const service = new CryptoService();

      expect(mockedFs.existsSync).toHaveBeenCalled();
      expect(mockedFs.readFileSync).toHaveBeenCalled();
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
      expect(service).toBeDefined();
    });

    it('should generate and write a new key when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const service = new CryptoService();

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.encryption_key'),
        expect.any(String),
        { mode: 0o600 },
      );
      expect(service).toBeDefined();
    });

    it('should use DATABASE_URL to determine key path', () => {
      const origDbUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = '/custom/path/db.sqlite';
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(fakeKeyHex);

      new CryptoService();

      expect(mockedFs.existsSync).toHaveBeenCalledWith(
        expect.stringContaining('/custom/path/.encryption_key'),
      );

      // Restore
      if (origDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = origDbUrl;
      }
    });
  });

  describe('encrypt', () => {
    it('should produce enc: prefixed output', () => {
      const service = createServiceWithExistingKey();
      const result = service.encrypt('hello world');

      expect(result).toMatch(/^enc:/);
    });

    it('should produce output with three colon-separated base64 parts after prefix', () => {
      const service = createServiceWithExistingKey();
      const result = service.encrypt('test data');

      const payload = result.slice('enc:'.length);
      const parts = payload.split(':');
      expect(parts).toHaveLength(3);
      // Each part should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      }
    });
  });

  describe('decrypt', () => {
    it('should reverse encrypt (round-trip)', () => {
      const service = createServiceWithExistingKey();
      const plaintext = 'secret message 123!';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should return plaintext as-is for legacy (non-prefixed) values', () => {
      const service = createServiceWithExistingKey();
      const legacy = 'plain-api-key-value';
      const result = service.decrypt(legacy);

      expect(result).toBe(legacy);
    });

    it('should handle empty string plaintext', () => {
      const service = createServiceWithExistingKey();
      const encrypted = service.encrypt('');
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe('');
    });

    it('should handle unicode text', () => {
      const service = createServiceWithExistingKey();
      const text = 'שלום עולם';
      const encrypted = service.encrypt(text);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(text);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for enc: prefixed values', () => {
      const service = createServiceWithExistingKey();
      expect(service.isEncrypted('enc:abc:def:ghi')).toBe(true);
    });

    it('should return false for non-prefixed values', () => {
      const service = createServiceWithExistingKey();
      expect(service.isEncrypted('plain-value')).toBe(false);
    });

    it('should return false for empty string', () => {
      const service = createServiceWithExistingKey();
      expect(service.isEncrypted('')).toBe(false);
    });
  });
});
