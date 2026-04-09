import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhatsAppService } from './whatsapp.service';

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

  beforeEach(() => {
    service = new WhatsAppService(new EventEmitter2());
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
});
