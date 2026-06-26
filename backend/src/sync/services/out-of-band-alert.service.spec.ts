import { Test, TestingModule } from '@nestjs/testing';
import { OutOfBandAlertService } from './out-of-band-alert.service';
import { GMAIL_SERVICE } from '../../shared/constants/injection-tokens';
import { WhatsAppService } from '../../messages/services/whatsapp.service';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

describe('OutOfBandAlertService', () => {
  let service: OutOfBandAlertService;
  let mockGmail: { sendEmail: jest.Mock; getConnectedEmail: jest.Mock; getEmails: jest.Mock; getEmailsSince: jest.Mock };
  let mockWhatsApp: { isConnected: jest.Mock; sendMessage: jest.Mock };
  let mockSettings: { findByKey: jest.Mock };

  const settingsResolver = (overrides: Record<string, string> = {}) => (key: string) => {
    const defaults: Record<string, string> = {
      out_of_band_alerts_enabled: 'true',
      approval_channel: 'Family Approvals',
    };
    const v = overrides[key] ?? defaults[key];
    if (v === undefined) return Promise.reject(new Error(`Setting not found: ${key}`));
    return Promise.resolve({ value: v });
  };

  beforeEach(async () => {
    mockGmail = {
      sendEmail: jest.fn().mockResolvedValue(undefined),
      getConnectedEmail: jest.fn().mockResolvedValue('user@example.com'),
      getEmails: jest.fn(),
      getEmailsSince: jest.fn(),
    };
    mockWhatsApp = {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn().mockResolvedValue('msg-id-1'),
    };
    mockSettings = { findByKey: jest.fn().mockImplementation(settingsResolver()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutOfBandAlertService,
        { provide: GMAIL_SERVICE, useValue: mockGmail },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: SettingsService, useValue: mockSettings },
      ],
    }).compile();

    service = module.get(OutOfBandAlertService);
  });

  describe('routing by error code', () => {
    it.each([
      AppErrorCodes.WHATSAPP_INIT_FAILED,
      AppErrorCodes.WHATSAPP_SEND_FAILED,
      AppErrorCodes.WHATSAPP_FETCH_FAILED,
      AppErrorCodes.WHATSAPP_CHANNEL_NOT_FOUND,
      AppErrorCodes.APPROVAL_WHATSAPP_DISCONNECTED,
    ])('WhatsApp error code %s → sends email, does NOT send WhatsApp', async (code) => {
      await service.handleAppError({
        source: 'whatsapp',
        code,
        message: 'WhatsApp is offline',
      });

      expect(mockGmail.sendEmail).toHaveBeenCalledTimes(1);
      expect(mockWhatsApp.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      AppErrorCodes.OAUTH_REFRESH_FAILED,
      AppErrorCodes.OAUTH_NO_REFRESH_TOKEN,
      AppErrorCodes.EVENT_SYNC_GOOGLE_FAILED,
      AppErrorCodes.GMAIL_API_DISABLED,
    ])('Google error code %s → sends WhatsApp, does NOT send email', async (code) => {
      await service.handleAppError({
        source: 'calendar',
        code,
        message: 'Google API broke',
      });

      expect(mockWhatsApp.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
    });

    it('codes outside both buckets are ignored entirely', async () => {
      await service.handleAppError({
        source: 'crypto',
        code: AppErrorCodes.CRYPTO_DECRYPT_FAILED,
        message: 'secret could not be decrypted',
      });

      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
      expect(mockWhatsApp.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('content', () => {
    it('email alert includes the error code, message, timestamp, and remediation hint', async () => {
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message: 'Chromium failed to launch',
        timestamp: '2026-06-17T10:00:00.000Z',
      });

      const args = mockGmail.sendEmail.mock.calls[0][0];
      expect(args.subject).toContain('WhatsApp is offline');
      expect(args.subject).toContain('WHATSAPP_INIT_FAILED');
      expect(args.body).toContain('Chromium failed to launch');
      expect(args.body).toContain('WHATSAPP_INIT_FAILED');
      expect(args.body).toContain('2026-06-17T10:00:00.000Z');
      expect(args.body).toContain('Settings → WhatsApp');
    });

    it('WhatsApp alert is sent to the configured approval_channel with the same payload pieces', async () => {
      await service.handleAppError({
        source: 'calendar',
        code: AppErrorCodes.OAUTH_REFRESH_FAILED,
        message: 'refresh token expired',
        timestamp: '2026-06-17T10:00:00.000Z',
      });

      expect(mockWhatsApp.sendMessage).toHaveBeenCalledTimes(1);
      const [channel, body] = mockWhatsApp.sendMessage.mock.calls[0];
      expect(channel).toBe('Family Approvals');
      expect(body).toContain('Google connection problem');
      expect(body).toContain('refresh token expired');
      expect(body).toContain('OAUTH_REFRESH_FAILED');
      expect(body).toContain('Settings → Google Accounts');
    });
  });

  describe('graceful degradation when the alert channel is also broken', () => {
    it('Google error + WhatsApp also disconnected → log only, no throw', async () => {
      mockWhatsApp.isConnected.mockReturnValue(false);

      await expect(
        service.handleAppError({
          source: 'calendar',
          code: AppErrorCodes.OAUTH_REFRESH_FAILED,
          message: 'oauth gone',
        }),
      ).resolves.toBeUndefined();
      expect(mockWhatsApp.sendMessage).not.toHaveBeenCalled();
      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
    });

    it('Google error + no approval_channel configured → log only, no throw', async () => {
      mockSettings.findByKey.mockImplementation(settingsResolver({ approval_channel: '' }));

      await service.handleAppError({
        source: 'calendar',
        code: AppErrorCodes.OAUTH_REFRESH_FAILED,
        message: 'oauth gone',
      });

      expect(mockWhatsApp.sendMessage).not.toHaveBeenCalled();
    });

    it('WhatsApp error + email send throws → log only, no throw', async () => {
      mockGmail.sendEmail.mockRejectedValue(new Error('SMTP unreachable'));

      await expect(
        service.handleAppError({
          source: 'whatsapp',
          code: AppErrorCodes.WHATSAPP_INIT_FAILED,
          message: 'no chromium',
        }),
      ).resolves.toBeUndefined();
    });

    it('Google error + WhatsApp send throws → log only, no throw', async () => {
      mockWhatsApp.sendMessage.mockRejectedValue(new Error('whatsapp 401'));

      await expect(
        service.handleAppError({
          source: 'calendar',
          code: AppErrorCodes.OAUTH_REFRESH_FAILED,
          message: 'oauth gone',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('dedupe', () => {
    it('does not re-alert the same code within 24 hours', async () => {
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_SEND_FAILED,
        message: 'fail 1',
      });
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_SEND_FAILED,
        message: 'fail 2 — minutes later',
      });

      expect(mockGmail.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('different codes are deduped independently', async () => {
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message: 'init',
      });
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_SEND_FAILED,
        message: 'send',
      });

      expect(mockGmail.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('a failed send is NOT recorded as deduped — the next attempt can retry', async () => {
      mockGmail.sendEmail.mockRejectedValueOnce(new Error('SMTP down'));
      mockGmail.sendEmail.mockResolvedValueOnce(undefined);

      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message: 'first',
      });
      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message: 'second',
      });

      expect(mockGmail.sendEmail).toHaveBeenCalledTimes(2);
    });
  });

  describe('master toggle', () => {
    it('skips everything when out_of_band_alerts_enabled = false', async () => {
      mockSettings.findByKey.mockImplementation(
        settingsResolver({ out_of_band_alerts_enabled: 'false' }),
      );

      await service.handleAppError({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message: 'irrelevant',
      });
      await service.handleAppError({
        source: 'calendar',
        code: AppErrorCodes.OAUTH_REFRESH_FAILED,
        message: 'irrelevant',
      });

      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
      expect(mockWhatsApp.sendMessage).not.toHaveBeenCalled();
    });
  });
});
