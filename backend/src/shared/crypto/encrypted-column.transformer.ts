import { ValueTransformer } from 'typeorm';
import { CryptoService } from './crypto.service';

/**
 * TypeORM column transformer that encrypts on write and decrypts on read.
 * Uses a module-level singleton so the transformer works inside entity metadata
 * (where DI is not available).
 */
let sharedCrypto: CryptoService | null = null;

function getCrypto(): CryptoService {
  if (!sharedCrypto) {
    sharedCrypto = new CryptoService();
  }
  return sharedCrypto;
}

export class EncryptedColumnTransformer implements ValueTransformer {
  to(value: string | null): string | null {
    if (value == null) return null;
    return getCrypto().encrypt(value);
  }

  from(value: string | null): string | null {
    if (value == null) return null;
    return getCrypto().decrypt(value);
  }
}
