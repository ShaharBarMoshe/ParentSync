import { GmailService } from './gmail.service';
import { OAuthService } from '../../auth/services/oauth.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

// Mock googleapis
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn().mockReturnValue({
      users: {
        messages: {
          list: jest.fn().mockResolvedValue({
            data: {
              messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
            },
          }),
          get: jest.fn().mockImplementation(({ id }) => ({
            data: {
              id,
              threadId: `thread-${id}`,
              labelIds: ['INBOX'],
              payload: {
                headers: [
                  { name: 'Subject', value: `Test Subject ${id}` },
                  { name: 'From', value: 'test@example.com' },
                  { name: 'Date', value: '2026-03-15T10:00:00Z' },
                ],
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Test email body').toString('base64'),
                },
              },
            },
          })),
        },
      },
    }),
    auth: {
      OAuth2: jest.fn(),
    },
  },
}));

describe('GmailService', () => {
  let service: GmailService;
  let mockOAuthService: jest.Mocked<OAuthService>;
  let mockAppErrorEmitter: jest.Mocked<AppErrorEmitterService>;

  beforeEach(() => {
    mockOAuthService = {
      getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
      getOAuth2Client: jest.fn().mockReturnValue({
        setCredentials: jest.fn(),
      }),
    } as any;

    mockAppErrorEmitter = {
      emit: jest.fn(),
      clear: jest.fn(),
    } as unknown as jest.Mocked<AppErrorEmitterService>;

    service = new GmailService(mockOAuthService, mockAppErrorEmitter);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should fetch emails', async () => {
    const emails = await service.getEmails(10);
    expect(emails).toHaveLength(2);
    expect(mockOAuthService.getValidAccessToken).toHaveBeenCalled();
  });

  it('should fetch emails since a date', async () => {
    const since = new Date('2026-03-14');
    const emails = await service.getEmailsSince(since);
    expect(emails).toHaveLength(2);
  });

  it('should pass query parameter', async () => {
    const emails = await service.getEmails(5, 'from:test@example.com');
    expect(emails).toHaveLength(2);
  });

  it('emits GMAIL_API_DISABLED when the project does not have Gmail enabled', async () => {
    const { google } = jest.requireMock('googleapis');
    const list = google.gmail().users.messages.list;
    const apiErr = Object.assign(new Error('Gmail API has not been used in project 123 before or it is disabled'), {
      code: 403,
      errors: [{ reason: 'accessNotConfigured', message: 'Gmail API has not been used' }],
    });
    list.mockRejectedValueOnce(apiErr);

    await expect(service.getEmails(10)).rejects.toThrow(/Gmail API/);
    expect(mockAppErrorEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'gmail',
        code: AppErrorCodes.GMAIL_API_DISABLED,
      }),
    );
  });

  it('does not emit GMAIL_API_DISABLED for unrelated errors', async () => {
    const { google } = jest.requireMock('googleapis');
    const list = google.gmail().users.messages.list;
    list.mockRejectedValueOnce(new Error('Network unreachable'));

    await expect(service.getEmails(10)).rejects.toThrow();
    expect(mockAppErrorEmitter.emit).not.toHaveBeenCalled();
  });
});
