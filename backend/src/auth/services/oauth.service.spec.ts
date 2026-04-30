import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { OAuthService } from './oauth.service';
import { OAuthTokenEntity } from '../entities/oauth-token.entity';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

// Mock googleapis
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
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
      })),
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

  it('should report authentication status for both purposes', async () => {
    mockTokenRepository.findOne.mockImplementation(({ where }) => {
      if (where.purpose === 'gmail') {
        return Promise.resolve({ provider: 'google', purpose: 'gmail', email: 'gmail@test.com' });
      }
      return Promise.resolve(null);
    });

    const status = await service.getAuthStatus();
    expect(status.gmail).toEqual({ authenticated: true, email: 'gmail@test.com' });
    expect(status.calendar).toEqual({ authenticated: false });
  });

  it('should report both accounts as authenticated', async () => {
    mockTokenRepository.findOne.mockImplementation(({ where }) => {
      if (where.purpose === 'gmail') {
        return Promise.resolve({ provider: 'google', purpose: 'gmail', email: 'gmail@test.com' });
      }
      return Promise.resolve({ provider: 'google', purpose: 'calendar', email: 'calendar@test.com' });
    });

    const status = await service.getAuthStatus();
    expect(status.gmail.authenticated).toBe(true);
    expect(status.calendar.authenticated).toBe(true);
    expect(status.gmail.email).toBe('gmail@test.com');
    expect(status.calendar.email).toBe('calendar@test.com');
  });

  it('should check authentication for specific purpose', async () => {
    mockTokenRepository.findOne.mockResolvedValue({ provider: 'google', purpose: 'gmail' });
    expect(await service.isAuthenticated('gmail')).toBe(true);

    mockTokenRepository.findOne.mockResolvedValue(null);
    expect(await service.isAuthenticated('calendar')).toBe(false);
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
