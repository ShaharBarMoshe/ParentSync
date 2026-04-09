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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
