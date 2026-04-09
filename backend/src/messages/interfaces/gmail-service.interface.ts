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
}
