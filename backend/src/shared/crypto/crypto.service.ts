import { Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppErrorEmitterService } from '../errors/app-error-emitter.service';
import { AppErrorCodes } from '../errors/app-error-codes';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_FILE_NAME = '.encryption_key';

/** Prefix to identify encrypted values in the database. */
const ENCRYPTED_PREFIX = 'enc:';

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  // appErrorEmitter is optional because EncryptedColumnTransformer
  // instantiates CryptoService outside the DI container — see
  // encrypted-column.transformer.ts. In that path, a decrypt failure still
  // throws, it just won't surface a UI modal (the column-level call site is
  // sync-driven and a higher-level catch will run anyway).
  constructor(
    @Optional() private readonly appErrorEmitter?: AppErrorEmitterService,
  ) {
    this.key = this.loadOrCreateKey();
  }

  private getKeyPath(): string {
    const dbUrl = process.env.DATABASE_URL || path.join(os.homedir(), '.parentsync', 'parentsync.sqlite');
    const dbDir = path.dirname(path.resolve(dbUrl));
    return path.join(dbDir, KEY_FILE_NAME);
  }

  private loadOrCreateKey(): Buffer {
    const keyPath = this.getKeyPath();

    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf-8').trim();
      return Buffer.from(hex, 'hex');
    }

    const key = crypto.randomBytes(KEY_LENGTH);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
    this.logger.log('Generated new encryption key');
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Format: enc:<iv>:<authTag>:<ciphertext> (all base64)
    return (
      ENCRYPTED_PREFIX +
      iv.toString('base64') +
      ':' +
      authTag.toString('base64') +
      ':' +
      encrypted.toString('base64')
    );
  }

  decrypt(stored: string): string {
    if (!stored.startsWith(ENCRYPTED_PREFIX)) {
      // Not encrypted (legacy plaintext value) — return as-is
      return stored;
    }

    try {
      const payload = stored.slice(ENCRYPTED_PREFIX.length);
      const [ivB64, tagB64, dataB64] = payload.split(':');

      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(tagB64, 'base64');
      const encrypted = Buffer.from(dataB64, 'base64');

      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);

      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf-8');
    } catch (error) {
      this.appErrorEmitter?.emit({
        source: 'crypto',
        code: AppErrorCodes.CRYPTO_DECRYPT_FAILED,
        message:
          'A stored secret could not be decrypted. The encryption key may have been replaced — re-enter your API keys and Google credentials in Settings.',
      });
      throw error;
    }
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTED_PREFIX);
  }
}
