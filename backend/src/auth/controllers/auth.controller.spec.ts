import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { OAuthService } from '../services/oauth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let oauthService: jest.Mocked<OAuthService>;
  let res: any;

  function createMockResponse() {
    const r: any = {};
    r.redirect = jest.fn();
    r.clearCookie = jest.fn();
    r.cookie = jest.fn();
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    return r;
  }

  function buildModule(envOverrides: Record<string, string> = {}) {
    const env: Record<string, string> = {
      FRONTEND_URL: 'http://localhost:5173',
      NODE_ENV: 'development',
      ...envOverrides,
    };

    const mockOAuthService = {
      handleCallback: jest.fn(),
      getAuthStatus: jest.fn(),
      getAuthorizationUrl: jest.fn(),
      disconnect: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        return env[key] ?? defaultValue;
      }),
    };

    return Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: OAuthService, useValue: mockOAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
  }

  beforeEach(async () => {
    const module: TestingModule = await buildModule();
    controller = module.get<AuthController>(AuthController);
    oauthService = module.get(OAuthService);
    res = createMockResponse();
  });

  describe('handleGoogleCallback', () => {
    it('should redirect with success params on successful callback', async () => {
      oauthService.handleCallback.mockResolvedValue('gmail' as any);

      await controller.handleGoogleCallback('auth-code', 'state-123', res);

      expect(oauthService.handleCallback).toHaveBeenCalledWith('auth-code', 'state-123');
      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state');
      expect(res.redirect).toHaveBeenCalledWith(
        'http://localhost:5173/settings?auth=success&purpose=gmail',
      );
    });

    it('should redirect with error message on failure', async () => {
      oauthService.handleCallback.mockRejectedValue(new Error('Token exchange failed'));

      await controller.handleGoogleCallback('bad-code', 'state-123', res);

      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state');
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('auth=error'),
      );
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('Token%20exchange%20failed'),
      );
    });

    it('should sanitize error messages with newlines', async () => {
      oauthService.handleCallback.mockRejectedValue(
        new Error('line1\nline2\rline3'),
      );

      await controller.handleGoogleCallback('code', 'state', res);

      // newlines replaced with spaces
      const redirectUrl: string = res.redirect.mock.calls[0][0];
      const message = decodeURIComponent(
        new URL(redirectUrl).searchParams.get('message')!,
      );
      expect(message).not.toContain('\n');
      expect(message).not.toContain('\r');
      expect(message).toBe('line1 line2 line3');
    });

    it('should truncate long error messages', async () => {
      const longMessage = 'A'.repeat(300);
      oauthService.handleCallback.mockRejectedValue(new Error(longMessage));

      await controller.handleGoogleCallback('code', 'state', res);

      const redirectUrl: string = res.redirect.mock.calls[0][0];
      const message = decodeURIComponent(
        new URL(redirectUrl).searchParams.get('message')!,
      );
      expect(message.length).toBe(200);
    });

    it('should use default message when error has no message', async () => {
      const error = new Error();
      error.message = '';
      oauthService.handleCallback.mockRejectedValue(error);

      await controller.handleGoogleCallback('code', 'state', res);

      const redirectUrl: string = res.redirect.mock.calls[0][0];
      const message = decodeURIComponent(
        new URL(redirectUrl).searchParams.get('message')!,
      );
      expect(message).toBe('Authentication failed');
    });
  });

  describe('getAuthStatus', () => {
    it('should delegate to oauthService.getAuthStatus', async () => {
      const mockStatus = {
        gmail: { authenticated: true, email: 'user@gmail.com' },
        calendar: { authenticated: false },
      };
      oauthService.getAuthStatus.mockResolvedValue(mockStatus as any);

      const result = await controller.getAuthStatus();

      expect(oauthService.getAuthStatus).toHaveBeenCalled();
      expect(result).toEqual(mockStatus);
    });
  });

  describe('startGoogleAuth', () => {
    it('should set cookie and redirect for valid purpose "gmail"', () => {
      oauthService.getAuthorizationUrl.mockReturnValue({
        url: 'https://accounts.google.com/oauth?purpose=gmail',
        state: 'random-state',
      } as any);

      controller.startGoogleAuth('gmail', res);

      expect(oauthService.getAuthorizationUrl).toHaveBeenCalledWith('gmail');
      expect(res.cookie).toHaveBeenCalledWith('oauth_state', 'random-state', {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
        path: '/api/auth',
      });
      expect(res.redirect).toHaveBeenCalledWith(
        'https://accounts.google.com/oauth?purpose=gmail',
      );
    });

    it('should set cookie and redirect for valid purpose "calendar"', () => {
      oauthService.getAuthorizationUrl.mockReturnValue({
        url: 'https://accounts.google.com/oauth?purpose=calendar',
        state: 'cal-state',
      } as any);

      controller.startGoogleAuth('calendar', res);

      expect(oauthService.getAuthorizationUrl).toHaveBeenCalledWith('calendar');
      expect(res.redirect).toHaveBeenCalledWith(
        'https://accounts.google.com/oauth?purpose=calendar',
      );
    });

    it('should return 400 for invalid purpose', () => {
      controller.startGoogleAuth('invalid', res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Invalid purpose. Use "gmail" or "calendar".',
      });
      expect(oauthService.getAuthorizationUrl).not.toHaveBeenCalled();
    });
  });

  describe('cookie secure flag', () => {
    it('should set secure: false in development', () => {
      oauthService.getAuthorizationUrl.mockReturnValue({
        url: 'https://example.com',
        state: 'state',
      } as any);

      controller.startGoogleAuth('gmail', res);

      expect(res.cookie).toHaveBeenCalledWith(
        'oauth_state',
        'state',
        expect.objectContaining({ secure: false }),
      );
    });

  });

  describe('disconnect', () => {
    it('should disconnect and return 204 for valid purpose', async () => {
      oauthService.disconnect.mockResolvedValue(undefined);

      await controller.disconnect('gmail', res);

      expect(oauthService.disconnect).toHaveBeenCalledWith('gmail');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('should return 400 for invalid purpose', async () => {
      await controller.disconnect('invalid', res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Invalid purpose. Use "gmail" or "calendar".',
      });
      expect(oauthService.disconnect).not.toHaveBeenCalled();
    });
  });
});
