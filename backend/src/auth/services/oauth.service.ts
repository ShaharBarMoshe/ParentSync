import {
  Injectable,
  Logger,
  UnauthorizedException,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { google, Auth } from 'googleapis';
import { OnEvent } from '@nestjs/event-emitter';
import { OAuthTokenEntity, OAuthPurpose } from '../entities/oauth-token.entity';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';
import * as crypto from 'crypto';

const PROVIDER_GOOGLE = 'google';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REDIRECT_URI = `http://localhost:${process.env.PORT || 41932}/api/auth/google/callback`;

const SCOPES_BY_PURPOSE: Record<OAuthPurpose, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    // Phase 24+ — used by OutOfBandAlertService to email the user when
    // WhatsApp is unreachable. Narrow scope: send-only, no inbox modify.
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};

/** Health of one Google account, as opposed to merely whether a row exists. */
export type OAuthAccountState =
  | 'disconnected'
  | 'connected'
  | 'expiring'
  | 'broken';

export interface OAuthAccountStatus {
  /**
   * Usable right now. False when the stored refresh token is rejected by
   * Google, even though a row still exists — see `OAuthTokenEntity`.
   */
  authenticated: boolean;
  state: OAuthAccountState;
  email?: string;
  expiresAt?: string;
  lastError?: string;
}

@Injectable()
export class OAuthService implements OnModuleInit {
  private readonly logger = new Logger(OAuthService.name);
  /**
   * Client config, kept so a fresh `OAuth2Client` can be built per call.
   *
   * A single shared client is unsafe here: `setCredentials()` mutates it, the
   * app holds tokens for **two different Google accounts** (gmail and calendar
   * are authorized separately), and `google.gmail({ auth: client })` keeps a
   * *reference* — so a later `setCredentials` for the other account silently
   * re-points an already-built API client at the wrong credentials.
   */
  private clientConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null = null;
  private pendingStates = new Map<
    string,
    { codeVerifier: string; purpose: OAuthPurpose; createdAt: number }
  >();

  constructor(
    private readonly settingsService: SettingsService,
    @InjectRepository(OAuthTokenEntity)
    private readonly tokenRepository: Repository<OAuthTokenEntity>,
    private readonly appErrorEmitter: AppErrorEmitterService,
  ) {}

  async onModuleInit() {
    await this.buildOAuth2Client();
  }

  private async buildOAuth2Client() {
    const clientId = await this.getSetting('google_client_id');
    const clientSecret = await this.getSetting('google_client_secret');
    const redirectUri = await this.getSetting('google_redirect_uri') || DEFAULT_REDIRECT_URI;

    this.logger.log(`OAuth init: client_id=${clientId ? 'SET (' + clientId.substring(0, 10) + '...)' : 'MISSING'}, client_secret=${clientSecret ? 'SET (len=' + clientSecret.length + ')' : 'MISSING'}, redirect_uri=${redirectUri}`);

    if (clientId && clientSecret) {
      this.clientConfig = { clientId, clientSecret, redirectUri };
      this.logger.log('Google OAuth configured from settings');
    } else {
      this.clientConfig = null;
      this.logger.warn('Google OAuth not configured — set google_client_id and google_client_secret in settings');
    }
  }

  @OnEvent('settings.changed')
  async handleSettingsChanged(payload: { key: string; value: string }) {
    if (['google_client_id', 'google_client_secret', 'google_redirect_uri'].includes(payload.key)) {
      await this.buildOAuth2Client();
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    try {
      const setting = await this.settingsService.findByKeyDecrypted(key);
      return setting.value;
    } catch {
      return null;
    }
  }

  /**
   * A **new** OAuth2Client on every call.
   *
   * Deliberately never cached. Callers set credentials on what they get back,
   * and with two accounts in play a shared instance means one account's token
   * can land on the other's API client. Construction is local — it opens no
   * connection — so a fresh one per call costs nothing.
   */
  private ensureConfigured(): Auth.OAuth2Client {
    const { clientId, clientSecret, redirectUri } = this.assertConfigured();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Assert the app is configured without building anything. Callers that only
   * need to fail early — rather than actually talk to Google — use this, so
   * checking configuration does not allocate a client.
   */
  private assertConfigured(): NonNullable<OAuthService['clientConfig']> {
    if (!this.clientConfig) {
      throw new InternalServerErrorException(
        'Google OAuth not configured. Set google_client_id and google_client_secret in Settings.',
      );
    }
    return this.clientConfig;
  }

  getAuthorizationUrl(purpose: OAuthPurpose): { url: string; state: string } {
    const client = this.ensureConfigured();

    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    this.pendingStates.set(state, {
      codeVerifier,
      purpose,
      createdAt: Date.now(),
    });

    // Clean up old states (older than 10 minutes)
    for (const [key, value] of this.pendingStates.entries()) {
      if (Date.now() - value.createdAt > 10 * 60 * 1000) {
        this.pendingStates.delete(key);
      }
    }

    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES_BY_PURPOSE[purpose],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as any,
      prompt: 'consent',
    });

    return { url, state };
  }

  async handleCallback(code: string, state: string): Promise<OAuthPurpose> {
    const client = this.ensureConfigured();

    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new UnauthorizedException(
        'Invalid or expired state parameter. Please restart the authentication flow.',
      );
    }

    const { purpose } = pending;
    this.pendingStates.delete(state);

    try {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: pending.codeVerifier,
      });

      if (!tokens.access_token) {
        throw new InternalServerErrorException(
          'Failed to obtain access token from Google',
        );
      }

      await this.storeTokens(tokens, purpose);

      // Fetch and store the user's email address
      try {
        const email = await this.fetchUserEmail(tokens.access_token!);
        const tokenEntity = await this.tokenRepository.findOne({
          where: { provider: PROVIDER_GOOGLE, purpose },
        });
        if (tokenEntity) {
          tokenEntity.email = email;
          await this.tokenRepository.save(tokenEntity);
        }
      } catch (emailError) {
        this.logger.warn(`Failed to fetch user email: ${emailError.message}`);
      }

      this.logger.log(`OAuth tokens stored for purpose: ${purpose}`);
      return purpose;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      this.logger.error(`OAuth callback error: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to exchange authorization code for tokens',
      );
    }
  }

  async getValidAccessToken(purpose: OAuthPurpose): Promise<string> {
    this.assertConfigured();

    const tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });

    if (tokenEntity) {
      const expiresIn = tokenEntity.expiresAt ? Math.round((tokenEntity.expiresAt.getTime() - Date.now()) / 1000) : 'unknown';
      this.logger.log(`Token for ${purpose}: expires in ${expiresIn}s, hasRefreshToken=${!!tokenEntity.refreshToken}`);
    }

    if (!tokenEntity) {
      throw new UnauthorizedException(
        `No OAuth tokens found for ${purpose}. Please authenticate with Google first.`,
      );
    }

    // Check if token needs refresh
    if (
      tokenEntity.expiresAt &&
      tokenEntity.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.refreshAccessToken(tokenEntity);
    }

    return tokenEntity.accessToken;
  }

  async getAuthStatus(): Promise<{
    gmail: OAuthAccountStatus;
    calendar: OAuthAccountStatus;
  }> {
    const [gmailToken, calendarToken] = await Promise.all([
      this.tokenRepository.findOne({
        where: { provider: PROVIDER_GOOGLE, purpose: 'gmail' },
      }),
      this.tokenRepository.findOne({
        where: { provider: PROVIDER_GOOGLE, purpose: 'calendar' },
      }),
    ]);

    return {
      gmail: OAuthService.describe(gmailToken),
      calendar: OAuthService.describe(calendarToken),
    };
  }

  /**
   * Classify one stored token by whether it can actually be used.
   *
   * The distinction this draws is the whole point: a row existing means the
   * account was linked *at some point*, which is not the same as the account
   * working now. Reporting the former as "connected" showed a green badge in
   * Settings while every sync failed on a refresh token Google had already
   * expired.
   */
  private static describe(
    token: OAuthTokenEntity | null,
  ): OAuthAccountStatus {
    if (!token) return { authenticated: false, state: 'disconnected' };

    const common = {
      email: token.email ?? undefined,
      expiresAt: token.expiresAt?.toISOString(),
    };

    // A recorded refresh failure is authoritative. `invalid_grant` means
    // Google rejected the refresh token itself, so no retry clears it — only
    // re-consent does.
    if (token.lastRefreshError) {
      return {
        authenticated: false,
        state: 'broken',
        lastError: token.lastRefreshError,
        ...common,
      };
    }

    // No refresh token means this token dies at expiry with no way back.
    if (!token.refreshToken) {
      return {
        authenticated: false,
        state: 'broken',
        lastError: 'No refresh token stored',
        ...common,
      };
    }

    const expiresInMs = token.expiresAt
      ? token.expiresAt.getTime() - Date.now()
      : null;
    if (expiresInMs !== null && expiresInMs < TOKEN_EXPIRY_BUFFER_MS) {
      // Due a refresh, but nothing is known to be wrong — the next call
      // refreshes it. Surfaced so the UI can distinguish this from healthy.
      return { authenticated: true, state: 'expiring', ...common };
    }

    return { authenticated: true, state: 'connected', ...common };
  }

  /** True only when the account is usable — not merely linked. */
  async isAuthenticated(purpose: OAuthPurpose): Promise<boolean> {
    const tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });
    return OAuthService.describe(tokenEntity).authenticated;
  }

  async disconnect(purpose: OAuthPurpose): Promise<void> {
    const tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });
    if (!tokenEntity) {
      return;
    }

    // Attempt to revoke the token at Google. Best-effort: the local row is
    // removed either way, so a failed revoke cannot strand the account in a
    // state the user can neither use nor re-link.
    if (this.clientConfig) {
      try {
        await this.ensureConfigured().revokeToken(tokenEntity.accessToken);
      } catch (error) {
        this.logger.warn(`Token revocation failed: ${error.message}`);
      }
    }

    await this.tokenRepository.remove(tokenEntity);
    this.logger.log(`Google account disconnected for purpose: ${purpose}`);
  }

  /**
   * A ready-to-use client for one purpose: refreshed if needed, credentials
   * already set, and **not shared with any other caller**.
   *
   * This replaces the old `getOAuth2Client()`, which handed every caller the
   * same mutable instance. Callers did:
   *
   * ```ts
   * const token  = await oauth.getValidAccessToken('gmail');
   * const client = oauth.getOAuth2Client();      // shared!
   * client.setCredentials({ access_token: token });
   * return google.gmail({ auth: client });       // holds a reference
   * ```
   *
   * Because the API client keeps a *reference*, the next caller's
   * `setCredentials` re-pointed an already-built client at different
   * credentials — and since gmail and calendar are authorized to two
   * different Google accounts, that meant Gmail calls could go out carrying
   * the calendar account's token.
   */
  async getAuthenticatedClient(
    purpose: OAuthPurpose,
  ): Promise<Auth.OAuth2Client> {
    const accessToken = await this.getValidAccessToken(purpose);
    const client = this.ensureConfigured();
    client.setCredentials({ access_token: accessToken });
    return client;
  }

  private async refreshAccessToken(
    tokenEntity: OAuthTokenEntity,
  ): Promise<string> {
    const client = this.ensureConfigured();

    if (!tokenEntity.refreshToken) {
      this.appErrorEmitter.emit({
        source: 'oauth',
        code: AppErrorCodes.OAUTH_NO_REFRESH_TOKEN,
        message: `No refresh token stored for Google ${tokenEntity.purpose}. Please re-authenticate in Settings.`,
      });
      throw new UnauthorizedException(
        `No refresh token available for ${tokenEntity.purpose}. Please re-authenticate with Google.`,
      );
    }

    try {
      client.setCredentials({
        refresh_token: tokenEntity.refreshToken,
      });

      const { credentials } = await client.refreshAccessToken();

      tokenEntity.accessToken = credentials.access_token!;
      if (credentials.expiry_date) {
        tokenEntity.expiresAt = new Date(credentials.expiry_date);
      }
      if (credentials.refresh_token) {
        tokenEntity.refreshToken = credentials.refresh_token;
      }

      tokenEntity.lastRefreshOk = new Date();
      tokenEntity.lastRefreshError = null;
      await this.tokenRepository.save(tokenEntity);
      this.logger.log(`OAuth access token refreshed for purpose: ${tokenEntity.purpose}`);
      this.appErrorEmitter.clear(AppErrorCodes.OAUTH_REFRESH_FAILED);
      this.appErrorEmitter.clear(AppErrorCodes.OAUTH_NO_REFRESH_TOKEN);

      return tokenEntity.accessToken;
    } catch (error) {
      this.logger.error(`Token refresh failed: ${error.message}`);

      // Record it on the row so the status endpoint stops claiming this
      // account is connected. Best-effort: a failed write must not mask the
      // refresh failure the caller is waiting on.
      try {
        tokenEntity.lastRefreshError = String(error.message ?? error);
        await this.tokenRepository.save(tokenEntity);
      } catch (saveError) {
        this.logger.warn(
          `Could not record refresh failure on the token row: ${(saveError as Error).message}`,
        );
      }

      this.appErrorEmitter.emit({
        source: 'oauth',
        code: AppErrorCodes.OAUTH_REFRESH_FAILED,
        message: `Google ${tokenEntity.purpose} access expired and could not be refreshed. Please re-authenticate in Settings.`,
      });
      throw new UnauthorizedException(
        `Failed to refresh access token for ${tokenEntity.purpose}. Please re-authenticate with Google.`,
      );
    }
  }

  private async fetchUserEmail(accessToken: string): Promise<string> {
    const client = this.ensureConfigured();
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    client.setCredentials({ access_token: accessToken });
    const { data } = await oauth2.userinfo.get();
    return data.email!;
  }

  private async storeTokens(
    tokens: Auth.Credentials,
    purpose: OAuthPurpose,
  ): Promise<void> {
    let tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });

    if (!tokenEntity) {
      tokenEntity = this.tokenRepository.create({
        provider: PROVIDER_GOOGLE,
        purpose,
      });
    }

    tokenEntity.accessToken = tokens.access_token!;
    tokenEntity.refreshToken = tokens.refresh_token ?? tokenEntity.refreshToken;
    tokenEntity.scope = tokens.scope ?? tokenEntity.scope;
    if (tokens.expiry_date) {
      tokenEntity.expiresAt = new Date(tokens.expiry_date);
    }
    // A fresh consent is what clears a `broken` account — without this the
    // status endpoint would keep reporting the old failure after a successful
    // reconnect, which is the same lie in the opposite direction.
    tokenEntity.lastRefreshOk = new Date();
    tokenEntity.lastRefreshError = null;

    await this.tokenRepository.save(tokenEntity);
    this.appErrorEmitter.clear(AppErrorCodes.OAUTH_REFRESH_FAILED);
    this.appErrorEmitter.clear(AppErrorCodes.OAUTH_NO_REFRESH_TOKEN);
  }
}
