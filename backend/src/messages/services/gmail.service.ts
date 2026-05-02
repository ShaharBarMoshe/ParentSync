import { Injectable, Logger } from '@nestjs/common';
import { google, gmail_v1 } from 'googleapis';
import { OAuthService } from '../../auth/services/oauth.service';
import {
  IGmailService,
  EmailMessage,
} from '../interfaces/gmail-service.interface';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

/**
 * Detects the Google "Gmail API has not been used in project N before or it is
 * disabled" response. Google's googleapis client surfaces this as either an
 * Error with `code === 403` and `errors[].reason === 'accessNotConfigured'`,
 * or as a plain string in `error.message`. We match on either to be safe.
 */
function isGmailApiDisabledError(error: unknown): boolean {
  const e = error as {
    code?: number;
    errors?: { reason?: string; message?: string }[];
    message?: string;
  };
  if (e?.code === 403) {
    if (e.errors?.some((x) => x.reason === 'accessNotConfigured')) return true;
    if (e.errors?.some((x) => /has not been used|is disabled/i.test(x.message ?? ''))) return true;
  }
  if (typeof e?.message === 'string') {
    return /Gmail API has not been used|gmail.googleapis.com.*disabled/i.test(
      e.message,
    );
  }
  return false;
}

@Injectable()
export class GmailService implements IGmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(
    private readonly oauthService: OAuthService,
    private readonly appErrorEmitter: AppErrorEmitterService,
  ) {}

  async getEmails(limit = 20, query?: string): Promise<EmailMessage[]> {
    const gmail = await this.getGmailClient();

    const listParams: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: 'me',
      maxResults: limit,
    };

    if (query) {
      listParams.q = query;
    }

    let listResponse;
    try {
      listResponse = await gmail.users.messages.list(listParams);
    } catch (error) {
      if (isGmailApiDisabledError(error)) {
        this.appErrorEmitter.emit({
          source: 'gmail',
          code: AppErrorCodes.GMAIL_API_DISABLED,
          message:
            'Gmail API is disabled in your Google Cloud project. Open Google Cloud Console → APIs & Services → enable the "Gmail API," wait ~1 minute, then retry the sync.',
        });
      }
      throw error;
    }
    const messageIds = listResponse.data.messages ?? [];

    if (messageIds.length === 0) {
      return [];
    }

    const emails: EmailMessage[] = [];
    for (const { id } of messageIds) {
      if (!id) continue;
      try {
        const email = await this.fetchEmailDetails(gmail, id);
        if (email) emails.push(email);
      } catch (error) {
        this.logger.warn(`Failed to fetch email ${id}: ${error.message}`);
      }
    }

    return emails;
  }

  async getEmailsSince(since: Date): Promise<EmailMessage[]> {
    const timestamp = Math.floor(since.getTime() / 1000);
    return this.getEmails(100, `after:${timestamp}`);
  }

  private async getGmailClient(): Promise<gmail_v1.Gmail> {
    const accessToken = await this.oauthService.getValidAccessToken('gmail');
    const oauth2Client = this.oauthService.getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });

    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  private async fetchEmailDetails(
    gmail: gmail_v1.Gmail,
    messageId: string,
  ): Promise<EmailMessage | null> {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const msg = response.data;
    const headers = msg.payload?.headers ?? [];

    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? '';

    const subject = getHeader('Subject');
    const sender = getHeader('From');
    const dateStr = getHeader('Date');
    const timestamp = dateStr ? new Date(dateStr) : new Date();

    const body = this.extractBody(msg.payload);
    const labels = msg.labelIds ?? [];
    const label = labels.includes('INBOX') ? 'INBOX' : (labels[0] ?? 'OTHER');

    return {
      subject,
      body,
      sender,
      timestamp,
      threadId: msg.threadId ?? messageId,
      label,
    };
  }

  private extractBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    // Check for plain text body
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Check multipart
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Fallback to HTML if no plain text
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }

    // Direct body
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    return '';
  }
}
