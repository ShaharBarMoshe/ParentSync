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
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};

@Injectable()
export class OAuthService implements OnModuleInit {
  private readonly logger = new Logger(OAuthService.name);
  private oauth2Client: Auth.OAuth2Client | null = null;
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
      this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      this.logger.log('Google OAuth configured from settings');
    } else {
      this.oauth2Client = null;
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

  private ensureConfigured(): Auth.OAuth2Client {
    if (!this.oauth2Client) {
      throw new InternalServerErrorException(
        'Google OAuth not configured. Set google_client_id and google_client_secret in Settings.',
      );
    }
    return this.oauth2Client;
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
    this.ensureConfigured();

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
    gmail: { authenticated: boolean; email?: string };
    calendar: { authenticated: boolean; email?: string };
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
      gmail: gmailToken
        ? { authenticated: true, email: gmailToken.email ?? undefined }
        : { authenticated: false },
      calendar: calendarToken
        ? { authenticated: true, email: calendarToken.email ?? undefined }
        : { authenticated: false },
    };
  }

  async isAuthenticated(purpose: OAuthPurpose): Promise<boolean> {
    const tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });
    return !!tokenEntity;
  }

  async disconnect(purpose: OAuthPurpose): Promise<void> {
    const tokenEntity = await this.tokenRepository.findOne({
      where: { provider: PROVIDER_GOOGLE, purpose },
    });
    if (!tokenEntity) {
      return;
    }

    // Attempt to revoke the token at Google
    if (this.oauth2Client) {
      try {
        await this.oauth2Client.revokeToken(tokenEntity.accessToken);
      } catch (error) {
        this.logger.warn(`Token revocation failed: ${error.message}`);
      }
    }

    await this.tokenRepository.remove(tokenEntity);
    this.logger.log(`Google account disconnected for purpose: ${purpose}`);
  }

  getOAuth2Client(): Auth.OAuth2Client {
    return this.ensureConfigured();
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

      await this.tokenRepository.save(tokenEntity);
      this.logger.log(`OAuth access token refreshed for purpose: ${tokenEntity.purpose}`);
      this.appErrorEmitter.clear(AppErrorCodes.OAUTH_REFRESH_FAILED);
      this.appErrorEmitter.clear(AppErrorCodes.OAUTH_NO_REFRESH_TOKEN);

      return tokenEntity.accessToken;
    } catch (error) {
      this.logger.error(`Token refresh failed: ${error.message}`);
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

    await this.tokenRepository.save(tokenEntity);
  }
}
