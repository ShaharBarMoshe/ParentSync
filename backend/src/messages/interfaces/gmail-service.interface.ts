export interface EmailMessage {
  subject: string;
  body: string;
  sender: string;
  timestamp: Date;
  threadId: string;
  label: string;
}

export interface IGmailService {
  getEmails(limit?: number, query?: string): Promise<EmailMessage[]>;
  getEmailsSince(since: Date): Promise<EmailMessage[]>;
  /**
   * Send a plain-text email from the connected Gmail account.
   * Used by `OutOfBandAlertService` to notify the user when WhatsApp
   * is unavailable (so the broken channel isn't also the alert channel).
   * `to` defaults to the connected account's own address.
   */
  sendEmail(args: { subject: string; body: string; to?: string }): Promise<void>;
  /** Address of the connected Gmail account. Null if not connected. */
  getConnectedEmail(): Promise<string | null>;
}
