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

  // Gmail caps a single page at 500. We chain pages until we've collected
  // up to `limit` IDs or run out — historically `getEmails(undefined, q)`
  // silently capped at 20 and dropped teacher mail beyond that.
  private static readonly DEFAULT_LIMIT = 500;
  private static readonly GMAIL_PAGE_SIZE = 500;

  async getEmails(limit?: number, query?: string): Promise<EmailMessage[]> {
    const gmail = await this.getGmailClient();
    const effectiveLimit = limit ?? GmailService.DEFAULT_LIMIT;
    // Gmail's default search excludes Spam / Trash / Drafts — teacher
    // mass-mail occasionally lands in Spam and would otherwise be invisible.
    // Caller-supplied `in:` clauses are respected.
    const effectiveQuery = this.applyDefaultScope(query);

    const messageIds = await this.listAllMessageIds(
      gmail,
      effectiveQuery,
      effectiveLimit,
    );

    if (messageIds.length === 0) {
      return [];
    }

    const emails: EmailMessage[] = [];
    for (const id of messageIds) {
      if (!id) continue;
      try {
        const email = await this.fetchEmailDetails(gmail, id);
        if (email) emails.push(email);
      } catch (error) {
        this.logger.warn(`Failed to fetch email ${id}: ${error.message}`);
      }
    }

    this.logger.log(
      `Gmail fetched ${emails.length} emails (query: "${effectiveQuery ?? '<none>'}", limit: ${effectiveLimit})`,
    );

    return emails;
  }

  async getEmailsSince(since: Date): Promise<EmailMessage[]> {
    const timestamp = Math.floor(since.getTime() / 1000);
    return this.getEmails(undefined, `after:${timestamp}`);
  }

  async getConnectedEmail(): Promise<string | null> {
    try {
      const gmail = await this.getGmailClient();
      const res = await gmail.users.getProfile({ userId: 'me' });
      return res.data.emailAddress ?? null;
    } catch (error) {
      this.logger.warn(
        `getConnectedEmail failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async sendEmail(args: { subject: string; body: string; to?: string }): Promise<void> {
    const gmail = await this.getGmailClient();
    const from = (await this.getConnectedEmail()) ?? 'me';
    const to = args.to ?? from;
    // RFC 5322. Subject + body are encoded as UTF-8 with base64 transfer.
    const subjectB64 = Buffer.from(args.subject, 'utf8').toString('base64');
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${subjectB64}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(args.body, 'utf8').toString('base64'),
    ];
    const raw = Buffer.from(headers.join('\r\n'), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    this.logger.log(`Sent alert email to ${to}: "${args.subject}"`);
  }

  /**
   * Iterates pages of `users.messages.list` until either `limit` IDs are
   * collected or Gmail stops returning a nextPageToken.
   */
  private async listAllMessageIds(
    gmail: gmail_v1.Gmail,
    query: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    do {
      const remaining = limit - ids.length;
      if (remaining <= 0) break;

      const pageSize = Math.min(remaining, GmailService.GMAIL_PAGE_SIZE);
      const listParams: gmail_v1.Params$Resource$Users$Messages$List = {
        userId: 'me',
        maxResults: pageSize,
      };
      if (query) listParams.q = query;
      if (pageToken) listParams.pageToken = pageToken;

      let response;
      try {
        response = await gmail.users.messages.list(listParams);
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

      for (const m of response.data.messages ?? []) {
        if (m.id) ids.push(m.id);
        if (ids.length >= limit) break;
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return ids;
  }

  /**
   * Prepends `in:anywhere` so Spam / Trash / Drafts are included in the
   * search. Skipped when the caller already specified a location filter
   * (`in:`, `is:`, `label:`).
   */
  private applyDefaultScope(query?: string): string | undefined {
    if (!query) return 'in:anywhere';
    if (/\b(in|is|label):/i.test(query)) return query;
    return `in:anywhere ${query}`;
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
