import { GmailService } from './gmail.service';
import { OAuthService } from '../../auth/services/oauth.service';

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

  beforeEach(() => {
    mockOAuthService = {
      getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
      getOAuth2Client: jest.fn().mockReturnValue({
        setCredentials: jest.fn(),
      }),
    } as any;

    service = new GmailService(mockOAuthService);
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
});
