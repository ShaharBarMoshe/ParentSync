import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { EncryptedColumnTransformer } from '../../shared/crypto/encrypted-column.transformer';

export type OAuthPurpose = 'gmail' | 'calendar';

@Entity('oauth_tokens')
@Unique(['provider', 'purpose'])
export class OAuthTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  provider: string;

  @Column({ type: 'varchar' })
  purpose: OAuthPurpose;

  @Column({ type: 'text', transformer: new EncryptedColumnTransformer() })
  accessToken: string;

  @Column({ type: 'text', nullable: true, transformer: new EncryptedColumnTransformer() })
  refreshToken: string;

  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date;

  @Column({ type: 'text', nullable: true })
  scope: string;

  @Column({ type: 'varchar', nullable: true })
  email: string;

  /**
   * When this token last refreshed successfully.
   *
   * Existence of a row is not evidence that the account works: Google expires
   * refresh tokens issued by an app in "Testing" publishing status after 7
   * days, and the row survives that with its refresh token intact. These two
   * columns are how the app tells "linked" apart from "usable".
   */
  @Column({ type: 'datetime', nullable: true })
  lastRefreshOk: Date | null;

  /**
   * The last refresh failure, cleared on the next success. `invalid_grant`
   * here means Google rejected the refresh token itself — no retry will fix
   * it, only re-consent.
   */
  @Column({ type: 'text', nullable: true })
  lastRefreshError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
