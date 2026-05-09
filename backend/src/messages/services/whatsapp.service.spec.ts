import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhatsAppService } from './whatsapp.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';

// Mock whatsapp-web.js — simulate 'ready' firing after initialize
jest.mock('whatsapp-web.js', () => {
  const eventHandlers: Record<string, Function[]> = {};
  const onceHandlers: Record<string, Function[]> = {};

  const mockClient = {
    on: jest.fn((event: string, handler: Function) => {
      (eventHandlers[event] ??= []).push(handler);
    }),
    once: jest.fn((event: string, handler: Function) => {
      (onceHandlers[event] ??= []).push(handler);
    }),
    initialize: jest.fn().mockImplementation(async () => {
      for (const h of eventHandlers['ready'] ?? []) h();
      for (const h of onceHandlers['ready'] ?? []) h();
      onceHandlers['ready'] = [];
    }),
    getChats: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
  };

  return {
    Client: jest.fn().mockImplementation(() => {
      Object.keys(eventHandlers).forEach(k => delete eventHandlers[k]);
      Object.keys(onceHandlers).forEach(k => delete onceHandlers[k]);
      return mockClient;
    }),
    LocalAuth: jest.fn(),
  };
});

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let appErrorEmitter: jest.Mocked<AppErrorEmitterService>;

  beforeEach(() => {
    appErrorEmitter = {
      emit: jest.fn(),
      clear: jest.fn(),
    } as unknown as jest.Mocked<AppErrorEmitterService>;
    service = new WhatsAppService(new EventEmitter2(), appErrorEmitter);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should report not connected initially', () => {
    expect(service.isConnected()).toBe(false);
  });

  it('should throw when getting messages while disconnected', async () => {
    await expect(
      service.getChannelMessages('test-channel'),
    ).rejects.toThrow('WhatsApp client is not connected');
  });

  it('should connect and become ready after initialize', async () => {
    await service.initialize();
    expect(service.isConnected()).toBe(true);
  });

  it('should call destroy on disconnect', async () => {
    await service.disconnect();
    expect(service.isConnected()).toBe(false);
  });

  it('should return empty array when fetchMessages throws (empty channel)', async () => {
    await service.initialize();

    const mockChat = {
      name: 'empty-channel',
      id: { _serialized: 'empty-channel@g.us' },
      fetchMessages: jest.fn().mockRejectedValue(
        new Error("Cannot read properties of undefined (reading 'waitForChatLoading')"),
      ),
    };

    const { Client } = require('whatsapp-web.js');
    const mockClient = new Client();
    mockClient.getChats.mockResolvedValue([mockChat]);
    // pupPage.evaluate (fetchMessagesDirectly) fails, then fallback fetchMessages also fails
    mockClient.pupPage = {
      evaluate: jest.fn().mockRejectedValue(new Error('Store not available')),
    };

    const result = await service.getChannelMessages('empty-channel');
    expect(result).toEqual([]);
  });

  describe('image messages', () => {
    /**
     * Stub the Puppeteer-direct path so we control the raw message list,
     * and stub `getMessageById` so we control downloadMedia(). Each test
     * sets these up against the singleton mock client.
     */
    async function setupClient(
      directRows: Array<Record<string, unknown>>,
      messageById: Record<string, { downloadMedia: jest.Mock }>,
    ) {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);
      mockClient.pupPage = {
        evaluate: jest.fn().mockResolvedValue(directRows),
      };
      mockClient.getMessageById = jest.fn(async (id: string) => messageById[id]);
      return mockClient;
    }

    it('keeps image-only messages and attaches downloaded image bytes', async () => {
      await setupClient(
        [
          {
            id: 'AAA',
            body: '',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'image',
          },
        ],
        {
          AAA: {
            downloadMedia: jest.fn().mockResolvedValue({
              mimetype: 'image/jpeg',
              data: 'BASE64BYTES',
              filename: 'flyer.jpg',
            }),
          },
        },
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
      expect(result[0].images).toEqual([
        { mimeType: 'image/jpeg', data: 'BASE64BYTES' },
      ]);
    });

    it('does not attach images to plain text messages', async () => {
      await setupClient(
        [
          {
            id: 'TXT',
            body: 'just text',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: false,
          },
        ],
        {},
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('just text');
      expect(result[0].images).toBeUndefined();
    });

    it('drops oversized images but keeps the message body', async () => {
      const oversizedBase64 = 'A'.repeat(8 * 1024 * 1024); // ~6 MB decoded — over 4 MB cap
      await setupClient(
        [
          {
            id: 'BIG',
            body: 'see flyer',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'image',
          },
        ],
        {
          BIG: {
            downloadMedia: jest.fn().mockResolvedValue({
              mimetype: 'image/jpeg',
              data: oversizedBase64,
            }),
          },
        },
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('see flyer');
      expect(result[0].images).toBeUndefined();
    });

    it('drops non-image media types (videos, documents, stickers)', async () => {
      await setupClient(
        [
          {
            id: 'VID',
            body: '',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'video',
          },
          {
            id: 'DOC',
            body: '',
            timestamp: 1_700_000_001,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'document',
          },
        ],
        {},
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(0);
    });

    it('keeps a text+image message with both content and images attached', async () => {
      await setupClient(
        [
          {
            id: 'MIX',
            body: 'school trip flyer',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'image',
          },
        ],
        {
          MIX: {
            downloadMedia: jest.fn().mockResolvedValue({
              mimetype: 'image/png',
              data: 'PNGBYTES',
            }),
          },
        },
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('school trip flyer');
      expect(result[0].images).toEqual([
        { mimeType: 'image/png', data: 'PNGBYTES' },
      ]);
    });

    it('continues without images when downloadMedia fails', async () => {
      await setupClient(
        [
          {
            id: 'FAIL',
            body: 'caption',
            timestamp: 1_700_000_000,
            from: 'sender@c.us',
            hasMedia: true,
            mediaType: 'image',
          },
        ],
        {
          FAIL: {
            downloadMedia: jest
              .fn()
              .mockRejectedValue(new Error('media decryption failed')),
          },
        },
      );

      const result = await service.getChannelMessages('class');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('caption');
      expect(result[0].images).toBeUndefined();
    });
  });
});
