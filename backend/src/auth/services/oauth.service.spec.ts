import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { OAuthService } from './oauth.service';
import { OAuthTokenEntity } from '../entities/oauth-token.entity';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

// Mock googleapis.
//
// The OAuth2 constructor returns one shared stub so a test can steer its
// behaviour, but every construction is still counted — which is how the
// per-purpose-client tests below assert that production code builds a fresh
// client rather than reusing one.
const mockOAuth2Instance = {
  generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/oauth'),
  getToken: jest.fn().mockResolvedValue({
    tokens: {
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expiry_date: Date.now() + 3600000,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    },
  }),
  refreshAccessToken: jest.fn().mockResolvedValue({
    credentials: {
      access_token: 'refreshed-access-token',
      expiry_date: Date.now() + 3600000,
    },
  }),
  setCredentials: jest.fn(),
  revokeToken: jest.fn().mockResolvedValue({}),
};

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => mockOAuth2Instance),
    },
    oauth2: jest.fn().mockReturnValue({
      userinfo: {
        get: jest.fn().mockResolvedValue({ data: { email: 'test@gmail.com' } }),
      },
    }),
  },
}));

describe('OAuthService', () => {
  let service: OAuthService;
  let mockTokenRepository: any;
  let mockSettingsService: any;
  let mockAppErrorEmitter: jest.Mocked<AppErrorEmitterService>;

  beforeEach(async () => {
    mockTokenRepository = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const settingsLookup = (key: string) => {
      const settings: Record<string, string> = {
        google_client_id: 'mock-client-id',
        google_client_secret: 'mock-client-secret',
        google_redirect_uri: 'http://localhost:41932/api/auth/google/callback',
      };
      if (settings[key]) {
        return Promise.resolve({ key, value: settings[key] });
      }
      return Promise.reject(new Error('Not found'));
    };

    mockSettingsService = {
      findByKey: jest.fn().mockImplementation(settingsLookup),
      findByKeyDecrypted: jest.fn().mockImplementation(settingsLookup),
    };

    mockAppErrorEmitter = {
      emit: jest.fn(),
      clear: jest.fn(),
    } as unknown as jest.Mocked<AppErrorEmitterService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OAuthService,
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
        {
          provide: getRepositoryToken(OAuthTokenEntity),
          useValue: mockTokenRepository,
        },
        {
          provide: AppErrorEmitterService,
          useValue: mockAppErrorEmitter,
        },
      ],
    }).compile();

    service = module.get<OAuthService>(OAuthService);
    await service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate authorization URL with state for gmail purpose', () => {
    const result = service.getAuthorizationUrl('gmail');
    expect(result.url).toBeDefined();
    expect(result.state).toBeDefined();
    expect(result.state.length).toBeGreaterThan(0);
  });

  it('should generate authorization URL for calendar purpose', () => {
    const result = service.getAuthorizationUrl('calendar');
    expect(result.url).toBeDefined();
    expect(result.state).toBeDefined();
  });

  it('should reject callback with invalid state', async () => {
    await expect(
      service.handleCallback('code', 'invalid-state'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should handle callback and return purpose', async () => {
    const { state } = service.getAuthorizationUrl('gmail');
    mockTokenRepository.findOne.mockResolvedValue(null);

    const purpose = await service.handleCallback('auth-code', state);
    expect(purpose).toBe('gmail');
    expect(mockTokenRepository.save).toHaveBeenCalled();
  });

  it('should handle callback for calendar purpose', async () => {
    const { state } = service.getAuthorizationUrl('calendar');
    mockTokenRepository.findOne.mockResolvedValue(null);

    const purpose = await service.handleCallback('auth-code', state);
    expect(purpose).toBe('calendar');
  });

  it('should throw when no tokens exist for purpose', async () => {
    mockTokenRepository.findOne.mockResolvedValue(null);
    await expect(service.getValidAccessToken('gmail')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return access token when valid for gmail', async () => {
    mockTokenRepository.findOne.mockResolvedValue({
      accessToken: 'valid-token',
      expiresAt: new Date(Date.now() + 3600000),
      provider: 'google',
      purpose: 'gmail',
    });

    const token = await service.getValidAccessToken('gmail');
    expect(token).toBe('valid-token');
  });

  it('should return access token for calendar purpose', async () => {
    mockTokenRepository.findOne.mockResolvedValue({
      accessToken: 'calendar-token',
      expiresAt: new Date(Date.now() + 3600000),
      provider: 'google',
      purpose: 'calendar',
    });

    const token = await service.getValidAccessToken('calendar');
    expect(token).toBe('calendar-token');
  });

  /** A linked, working account — always has a refresh token and a future expiry. */
  const healthyToken = (purpose: string, email: string) => ({
    provider: 'google',
    purpose,
    email,
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 3600000),
    lastRefreshOk: new Date(),
    lastRefreshError: null,
  });

  it('should report authentication status for both purposes', async () => {
    mockTokenRepository.findOne.mockImplementation(({ where }) =>
      Promise.resolve(
        where.purpose === 'gmail' ? healthyToken('gmail', 'gmail@test.com') : null,
      ),
    );

    const status = await service.getAuthStatus();
    expect(status.gmail).toMatchObject({
      authenticated: true,
      state: 'connected',
      email: 'gmail@test.com',
    });
    expect(status.calendar).toEqual({ authenticated: false, state: 'disconnected' });
  });

  it('should report both accounts as authenticated', async () => {
    mockTokenRepository.findOne.mockImplementation(({ where }) =>
      Promise.resolve(
        where.purpose === 'gmail'
          ? healthyToken('gmail', 'gmail@test.com')
          : healthyToken('calendar', 'calendar@test.com'),
      ),
    );

    const status = await service.getAuthStatus();
    expect(status.gmail.authenticated).toBe(true);
    expect(status.calendar.authenticated).toBe(true);
    expect(status.gmail.email).toBe('gmail@test.com');
    expect(status.calendar.email).toBe('calendar@test.com');
  });

  it('should check authentication for specific purpose', async () => {
    mockTokenRepository.findOne.mockResolvedValue(healthyToken('gmail', 'g@test.com'));
    expect(await service.isAuthenticated('gmail')).toBe(true);

    mockTokenRepository.findOne.mockResolvedValue(null);
    expect(await service.isAuthenticated('calendar')).toBe(false);
  });

  /**
   * Regression: the status endpoint used to return `!!row`, so an account
   * whose refresh token Google had expired still reported "connected".
   * Settings showed a green badge while every sync failed in the background —
   * for ~47 hours, on this machine, before anyone noticed.
   */
  describe('status reflects usability, not row existence', () => {
    it('reports a token with a recorded refresh failure as broken', async () => {
      mockTokenRepository.findOne.mockResolvedValue({
        ...healthyToken('gmail', 'gmail@test.com'),
        lastRefreshError: 'invalid_grant',
      });

      const status = await service.getAuthStatus();
      expect(status.gmail).toMatchObject({
        authenticated: false,
        state: 'broken',
        lastError: 'invalid_grant',
        email: 'gmail@test.com',
      });
    });

    it('keeps the account email on a broken token, so the user knows which to reconnect', async () => {
      mockTokenRepository.findOne.mockResolvedValue({
        ...healthyToken('gmail', 'shbmosh@gmail.com'),
        lastRefreshError: 'invalid_grant',
      });
      const status = await service.getAuthStatus();
      expect(status.gmail.email).toBe('shbmosh@gmail.com');
    });

    it('reports a row with no refresh token as broken, not connected', async () => {
      const token = healthyToken('gmail', 'gmail@test.com');
      mockTokenRepository.findOne.mockResolvedValue({ ...token, refreshToken: null });

      const status = await service.getAuthStatus();
      expect(status.gmail.state).toBe('broken');
      expect(status.gmail.authenticated).toBe(false);
    });

    it('reports a token due for refresh as expiring but still usable', async () => {
      mockTokenRepository.findOne.mockResolvedValue({
        ...healthyToken('calendar', 'cal@test.com'),
        expiresAt: new Date(Date.now() + 1000),
      });

      const status = await service.getAuthStatus();
      expect(status.calendar).toMatchObject({ authenticated: true, state: 'expiring' });
    });

    it('isAuthenticated() is false for a broken account', async () => {
      mockTokenRepository.findOne.mockResolvedValue({
        ...healthyToken('gmail', 'gmail@test.com'),
        lastRefreshError: 'invalid_grant',
      });
      expect(await service.isAuthenticated('gmail')).toBe(false);
    });

    it('records the failure on the row when a refresh is rejected', async () => {
      const token = {
        ...healthyToken('calendar', 'cal@test.com'),
        expiresAt: new Date(Date.now() - 1000),
      };
      mockTokenRepository.findOne.mockResolvedValue(token);
      mockOAuth2Instance.refreshAccessToken.mockRejectedValueOnce(
        new Error('invalid_grant'),
      );

      await expect(service.getValidAccessToken('calendar')).rejects.toThrow();
      expect(mockTokenRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastRefreshError: 'invalid_grant' }),
      );
    });

    it('clears the failure on the row after a successful refresh', async () => {
      const token = {
        ...healthyToken('calendar', 'cal@test.com'),
        expiresAt: new Date(Date.now() - 1000),
        lastRefreshError: 'invalid_grant',
      };
      mockTokenRepository.findOne.mockResolvedValue(token);

      await service.getValidAccessToken('calendar');
      expect(mockTokenRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastRefreshError: null }),
      );
    });
  });

  /**
   * Regression: `getOAuth2Client()` handed every caller the same mutable
   * client. `google.gmail({ auth: client })` keeps a *reference*, so the next
   * caller's setCredentials re-pointed an already-built API client — and with
   * gmail and calendar authorized to two different Google accounts, that meant
   * Gmail requests could carry the calendar account's token.
   */
  describe('per-purpose OAuth clients', () => {
    it('builds a fresh client for each authenticated call', async () => {
      const { google } = jest.requireMock('googleapis');
      mockTokenRepository.findOne.mockImplementation(({ where }) =>
        Promise.resolve(healthyToken(where.purpose, `${where.purpose}@test.com`)),
      );

      google.auth.OAuth2.mockClear();
      await service.getAuthenticatedClient('gmail');
      await service.getAuthenticatedClient('calendar');

      expect(google.auth.OAuth2).toHaveBeenCalledTimes(2);
    });

    it('sets each purpose its own access token', async () => {
      mockTokenRepository.findOne.mockImplementation(({ where }) =>
        Promise.resolve({
          ...healthyToken(where.purpose, `${where.purpose}@test.com`),
          accessToken: `${where.purpose}-token`,
        }),
      );

      mockOAuth2Instance.setCredentials.mockClear();
      await service.getAuthenticatedClient('gmail');
      await service.getAuthenticatedClient('calendar');

      expect(mockOAuth2Instance.setCredentials).toHaveBeenNthCalledWith(1, {
        access_token: 'gmail-token',
      });
      expect(mockOAuth2Instance.setCredentials).toHaveBeenNthCalledWith(2, {
        access_token: 'calendar-token',
      });
    });

    it('no longer exposes a shared client getter', () => {
      expect((service as unknown as Record<string, unknown>).getOAuth2Client)
        .toBeUndefined();
    });
  });

  it('should disconnect only the specified purpose', async () => {
    const tokenEntity = { provider: 'google', purpose: 'gmail', accessToken: 'token' };
    mockTokenRepository.findOne.mockResolvedValue(tokenEntity);

    await service.disconnect('gmail');
    expect(mockTokenRepository.remove).toHaveBeenCalledWith(tokenEntity);
  });

  it('should not fail when disconnecting non-existent purpose', async () => {
    mockTokenRepository.findOne.mockResolvedValue(null);
    await expect(service.disconnect('calendar')).resolves.toBeUndefined();
  });

  it('emits OAUTH_NO_REFRESH_TOKEN when token has no refresh_token', async () => {
    mockTokenRepository.findOne.mockResolvedValue({
      accessToken: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      refreshToken: null,
      provider: 'google',
      purpose: 'calendar',
    });

    await expect(service.getValidAccessToken('calendar')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mockAppErrorEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'oauth',
        code: AppErrorCodes.OAUTH_NO_REFRESH_TOKEN,
      }),
    );
  });

  it('emits OAUTH_REFRESH_FAILED when google rejects the refresh', async () => {
    mockTokenRepository.findOne.mockResolvedValue({
      accessToken: 'expired',
      expiresAt: new Date(Date.now() - 1000),
      refreshToken: 'stale-refresh-token',
      provider: 'google',
      purpose: 'calendar',
    });

    const { google } = jest.requireMock('googleapis');
    const oauth2Instance = google.auth.OAuth2.mock.results.at(-1)?.value;
    oauth2Instance.refreshAccessToken.mockRejectedValueOnce(
      new Error('invalid_grant'),
    );

    await expect(service.getValidAccessToken('calendar')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mockAppErrorEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'oauth',
        code: AppErrorCodes.OAUTH_REFRESH_FAILED,
      }),
    );
  });
});
