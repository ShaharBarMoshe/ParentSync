import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OAuthService } from './oauth.service';
import { OAuthTokenEntity } from '../entities/oauth-token.entity';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';

/**
 * Client isolation, against the **real** googleapis library.
 *
 * `oauth.service.spec.ts` mocks googleapis, and its OAuth2 constructor returns
 * one shared stub — so it can only assert that the constructor was *called*
 * twice. That catches a regression that caches the client, but it cannot prove
 * two calls actually yield two independent objects, because in that suite they
 * never do.
 *
 * This file deliberately does not mock googleapis, so it can assert the thing
 * that actually matters: credentials set on one purpose's client are invisible
 * to the other's. That is the property whose absence let a Gmail request go out
 * carrying the calendar account's token.
 *
 * No network is involved — `setCredentials` and `credentials` are local.
 */
describe('OAuth client isolation (real googleapis)', () => {
  let service: OAuthService;

  const tokenFor = (purpose: string) => ({
    provider: 'google',
    purpose,
    email: `${purpose}@example.com`,
    accessToken: `${purpose}-access-token`,
    refreshToken: `${purpose}-refresh-token`,
    // Comfortably in the future, so nothing tries to refresh over the network.
    expiresAt: new Date(Date.now() + 3600_000),
    lastRefreshOk: new Date(),
    lastRefreshError: null,
  });

  beforeEach(async () => {
    const settingsLookup = (key: string) => {
      const settings: Record<string, string> = {
        google_client_id: 'test-client-id',
        google_client_secret: 'test-client-secret',
        google_redirect_uri: 'http://localhost:41932/api/auth/google/callback',
      };
      return settings[key]
        ? Promise.resolve({ key, value: settings[key] })
        : Promise.reject(new Error('Not found'));
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OAuthService,
        {
          provide: SettingsService,
          useValue: {
            findByKey: jest.fn().mockImplementation(settingsLookup),
            findByKeyDecrypted: jest.fn().mockImplementation(settingsLookup),
          },
        },
        {
          provide: getRepositoryToken(OAuthTokenEntity),
          useValue: {
            findOne: jest
              .fn()
              .mockImplementation(({ where }) =>
                Promise.resolve(tokenFor(where.purpose)),
              ),
            create: jest.fn((d) => d),
            save: jest.fn((e) => Promise.resolve(e)),
            remove: jest.fn(),
          },
        },
        {
          provide: AppErrorEmitterService,
          useValue: { emit: jest.fn(), clear: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(OAuthService);
    await service.onModuleInit();
  });

  it('returns a different client object for each call', async () => {
    const a = await service.getAuthenticatedClient('gmail');
    const b = await service.getAuthenticatedClient('calendar');

    expect(a).not.toBe(b);
  });

  it('returns a different client object even for the same purpose twice', async () => {
    const first = await service.getAuthenticatedClient('gmail');
    const second = await service.getAuthenticatedClient('gmail');

    // Two Gmail API clients built moments apart must not share mutable state
    // either — a refresh on one would otherwise re-point the other.
    expect(first).not.toBe(second);
  });

  it('carries the right access token on each purpose', async () => {
    const gmail = await service.getAuthenticatedClient('gmail');
    const calendar = await service.getAuthenticatedClient('calendar');

    expect(gmail.credentials.access_token).toBe('gmail-access-token');
    expect(calendar.credentials.access_token).toBe('calendar-access-token');
  });

  /**
   * The actual regression. Previously both purposes shared one client, so
   * building the calendar client overwrote the credentials the already-built
   * Gmail client still referenced — and the two purposes are authorized to
   * two different Google accounts.
   */
  it('does not let one purpose overwrite the other credentials', async () => {
    const gmail = await service.getAuthenticatedClient('gmail');
    const tokenBefore = gmail.credentials.access_token;

    await service.getAuthenticatedClient('calendar');

    expect(gmail.credentials.access_token).toBe(tokenBefore);
    expect(gmail.credentials.access_token).toBe('gmail-access-token');
  });

  it('keeps an already-built API client pinned to its own credentials', async () => {
    // Mirrors how GmailService uses it: grab the client, hold it, then let
    // another purpose build its own.
    const held = await service.getAuthenticatedClient('gmail');
    await service.getAuthenticatedClient('calendar');
    await service.getAuthenticatedClient('calendar');

    expect(held.credentials.access_token).toBe('gmail-access-token');
  });
});
