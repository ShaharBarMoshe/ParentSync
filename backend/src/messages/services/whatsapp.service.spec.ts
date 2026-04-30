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
});
