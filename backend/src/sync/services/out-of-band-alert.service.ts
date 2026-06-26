import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GMAIL_SERVICE, WHATSAPP_SERVICE } from '../../shared/constants/injection-tokens';
import type { IGmailService } from '../../messages/interfaces/gmail-service.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

/**
 * Out-of-band cross-channel alerting.
 *
 * When one notification channel is broken, send the alert via the *other*
 * still-working channel — so the user always hears about an outage even if
 * the broken channel is the one we'd normally use.
 *
 *   - WhatsApp connection / send problems → send the alert by **email**.
 *   - Google (OAuth, Calendar, Tasks, Gmail) problems → send the alert via **WhatsApp**.
 *
 * Hooked to `app.error` events emitted by `AppErrorEmitterService`. The
 * emitter already dedupes within an hour; this service adds a longer
 * "don't email me about the same thing again today" gate so a persistent
 * failure produces ≤ 1 out-of-band alert per code per day.
 *
 * Disable via `out_of_band_alerts_enabled = 'false'` if the user finds
 * the alerts noisy. Default on.
 */
const SETTING_ENABLED = 'out_of_band_alerts_enabled';
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000; // 24h

/** Errors that mean WhatsApp is broken — alert via email instead. */
const WHATSAPP_BROKEN_CODES = new Set<string>([
  AppErrorCodes.WHATSAPP_INIT_FAILED,
  AppErrorCodes.WHATSAPP_FETCH_FAILED,
  AppErrorCodes.WHATSAPP_SEND_FAILED,
  AppErrorCodes.WHATSAPP_CHANNEL_NOT_FOUND,
  AppErrorCodes.APPROVAL_WHATSAPP_DISCONNECTED,
]);

/** Errors that mean Google (calendar/gmail/oauth) is broken — alert via WhatsApp instead. */
const GOOGLE_BROKEN_CODES = new Set<string>([
  AppErrorCodes.OAUTH_NO_REFRESH_TOKEN,
  AppErrorCodes.OAUTH_REFRESH_FAILED,
  AppErrorCodes.EVENT_SYNC_GOOGLE_FAILED,
  AppErrorCodes.GMAIL_API_DISABLED,
]);

interface ErrorEvent {
  source: string;
  code: string;
  message: string;
  timestamp?: string;
}

@Injectable()
export class OutOfBandAlertService {
  private readonly logger = new Logger(OutOfBandAlertService.name);
  private readonly lastAlerted = new Map<string, number>();

  constructor(
    @Inject(GMAIL_SERVICE) private readonly gmailService: IGmailService,
    @Inject(WHATSAPP_SERVICE) private readonly whatsAppService: IWhatsAppService,
    private readonly settingsService: SettingsService,
  ) {}

  @OnEvent('app.error')
  async handleAppError(payload: ErrorEvent): Promise<void> {
    if (!(await this.isEnabled())) return;
    if (this.isRecentlyAlerted(payload.code)) return;

    if (WHATSAPP_BROKEN_CODES.has(payload.code)) {
      await this.alertViaEmail(payload);
    } else if (GOOGLE_BROKEN_CODES.has(payload.code)) {
      await this.alertViaWhatsApp(payload);
    }
  }

  private async alertViaEmail(payload: ErrorEvent): Promise<void> {
    try {
      const subject = `ParentSync alert: WhatsApp is offline (${payload.code})`;
      const body = this.formatBody(
        'ParentSync could not reach WhatsApp Web.',
        payload,
        'Open the app and go to Settings → WhatsApp to scan the QR code again.',
      );
      await this.gmailService.sendEmail({ subject, body });
      this.markAlerted(payload.code);
      this.logger.log(`Out-of-band email alert sent for ${payload.code}`);
    } catch (error) {
      this.logger.warn(
        `Out-of-band email alert failed for ${payload.code}: ${(error as Error).message}`,
      );
    }
  }

  private async alertViaWhatsApp(payload: ErrorEvent): Promise<void> {
    if (!this.whatsAppService.isConnected()) {
      this.logger.debug(
        `Skipping WhatsApp alert for ${payload.code} — WhatsApp also offline`,
      );
      return;
    }
    const channel = await this.getApprovalChannel();
    if (!channel) {
      this.logger.debug(
        `Skipping WhatsApp alert for ${payload.code} — no approval_channel configured`,
      );
      return;
    }
    try {
      const subject = `⚠️ ParentSync: Google connection problem`;
      const body = this.formatBody(
        `ParentSync hit a Google API error (${payload.code}).`,
        payload,
        'Open the app → Settings → Google Accounts. Reconnecting usually fixes it.',
      );
      await this.whatsAppService.sendMessage(channel, `${subject}\n\n${body}`);
      this.markAlerted(payload.code);
      this.logger.log(`Out-of-band WhatsApp alert sent for ${payload.code}`);
    } catch (error) {
      this.logger.warn(
        `Out-of-band WhatsApp alert failed for ${payload.code}: ${(error as Error).message}`,
      );
    }
  }

  private formatBody(headline: string, payload: ErrorEvent, action: string): string {
    return [
      headline,
      '',
      `Error: ${payload.message}`,
      `Code:  ${payload.code}`,
      `Time:  ${payload.timestamp ?? new Date().toISOString()}`,
      '',
      action,
      '',
      '— ParentSync (this alert came from the other channel because the usual one is down)',
    ].join('\n');
  }

  private async isEnabled(): Promise<boolean> {
    try {
      const setting = await this.settingsService.findByKey(SETTING_ENABLED);
      return setting.value.toLowerCase() !== 'false';
    } catch {
      return true;
    }
  }

  private async getApprovalChannel(): Promise<string | null> {
    try {
      const setting = await this.settingsService.findByKey('approval_channel');
      const v = setting.value?.trim();
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  private isRecentlyAlerted(code: string): boolean {
    const last = this.lastAlerted.get(code);
    return last !== undefined && Date.now() - last < ALERT_DEDUPE_MS;
  }

  private markAlerted(code: string): void {
    this.lastAlerted.set(code, Date.now());
  }
}
