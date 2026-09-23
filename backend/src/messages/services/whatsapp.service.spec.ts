import { EventEmitter2 } from '@nestjs/event-emitter';
import { WhatsAppService, serializeMsgKey } from './whatsapp.service';
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
    getContacts: jest.fn().mockResolvedValue([]),
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
  describe('WhatsApp Web compatibility patch', () => {
    const realWindow = (global as any).window;

    afterEach(() => {
      (global as any).window = realWindow;
    });

    /** Grab the single-argument evaluate call — that is ensureBrowserPatches. */
    function patchCallback(evaluate: jest.Mock): Function {
      const call = evaluate.mock.calls.find((args) => args.length === 1);
      expect(call).toBeDefined();
      return call![0];
    }

    it('neutralises a malformed lastReceivedKey so getChatModel stops throwing', async () => {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);

      await service.getChannelMessages('class');

      // Reproduce the upstream bug: lastReceivedKey is present but its
      // _serialized is undefined, so the IndexedDB lookup rejects.
      const brokenChat = { lastReceivedKey: { _serialized: undefined } };
      const originalGetChatModel = jest.fn(async (chat: any) => {
        if (chat.lastReceivedKey) {
          if (chat.lastReceivedKey._serialized === undefined) {
            throw new Error(
              "DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.",
            );
          }
        }
        return { ok: true };
      });
      const fakeWindow: any = { WWebJS: { getChatModel: originalGetChatModel } };
      (global as any).window = fakeWindow;

      await expect(
        fakeWindow.WWebJS.getChatModel(brokenChat),
      ).rejects.toThrow('IDBObjectStore');

      patchCallback(evaluate)();

      await expect(
        fakeWindow.WWebJS.getChatModel(brokenChat),
      ).resolves.toEqual({ ok: true });
    });

    it('leaves a well-formed lastReceivedKey untouched', async () => {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);

      await service.getChannelMessages('class');

      const seen: unknown[] = [];
      const fakeWindow: any = {
        WWebJS: {
          getChatModel: jest.fn(async (chat: any) => {
            seen.push(chat.lastReceivedKey);
            return { ok: true };
          }),
        },
      };
      (global as any).window = fakeWindow;
      patchCallback(evaluate)();

      const key = { _serialized: 'true_123@g.us_ABC' };
      await fakeWindow.WWebJS.getChatModel({ lastReceivedKey: key });
      expect(seen).toEqual([key]);
    });

    it('applies the patch only once', async () => {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);

      await service.getChannelMessages('class');

      const original = jest.fn().mockResolvedValue({ ok: true });
      const fakeWindow: any = { WWebJS: { getChatModel: original } };
      (global as any).window = fakeWindow;

      const patch = patchCallback(evaluate);
      patch();
      const afterFirst = fakeWindow.WWebJS.getChatModel;
      patch();
      expect(fakeWindow.WWebJS.getChatModel).toBe(afterFirst);
    });

    it('reads chats through WhatsApp Web modules, not the removed window.Store', async () => {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);

      await service.getChannelMessages('class');

      // The fetch call carries the chat id, limit, smoke marker and the
      // include-own-messages flag.
      const fetchCall = evaluate.mock.calls.find((args) => args.length === 5);
      expect(fetchCall).toBeDefined();

      const chatModel = {
        msgs: {
          getModelsArray: () => [
            {
              isNotification: false,
              isSentByMe: false,
              body: 'hello',
              t: 1_700_000_000,
              type: 'chat',
              id: { _serialized: 'M1', remote: 'class@g.us' },
            },
          ],
        },
      };
      const modules: Record<string, unknown> = {
        WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
        WAWebCollections: { Chat: { get: () => chatModel } },
        WAWebFindChatAction: {
          findOrCreateLatestChat: async () => ({ chat: chatModel }),
        },
      };
      // No `Store` on this window on purpose — touching it would throw.
      (global as any).window = {
        require: (name: string) => modules[name],
      };

      const rows = await fetchCall![0]('class@g.us', 50, 'SMOKE');
      expect(rows).toEqual([
        expect.objectContaining({ id: 'M1', body: 'hello', from: 'class@g.us' }),
      ]);
    });
  });

  describe('dead browser session recovery', () => {
    const detached = () =>
      new Error("Attempted to use detached Frame 'D31076F01392AAEB7DC969502D2636B3'.");

    async function connectedClient() {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.pupPage = { evaluate: jest.fn().mockResolvedValue([]) };
      mockClient.initialize.mockClear();
      return mockClient;
    }

    it('reconnects and retries once when the Puppeteer frame is detached', async () => {
      const mockClient = await connectedClient();
      mockClient.getChats
        .mockRejectedValueOnce(detached())
        .mockResolvedValue([{ name: 'class', id: { _serialized: 'class@g.us' } }]);

      const result = await service.getChannelMessages('class');

      expect(result).toEqual([]);
      expect(mockClient.initialize).toHaveBeenCalledTimes(1);
      expect(service.isConnected()).toBe(true);
    });

    it('reconnects at most once per sync cycle', async () => {
      const mockClient = await connectedClient();
      mockClient.getChats.mockRejectedValue(detached());

      await expect(service.getChannelMessages('class')).rejects.toThrow(
        'detached Frame',
      );
      await expect(service.getChannelMessages('other')).rejects.toThrow(
        'detached Frame',
      );

      expect(mockClient.initialize).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh reconnect attempt after resetReconnectFlag', async () => {
      const mockClient = await connectedClient();
      mockClient.getChats.mockRejectedValue(detached());

      await expect(service.getChannelMessages('class')).rejects.toThrow();
      service.resetReconnectFlag();
      await expect(service.getChannelMessages('class')).rejects.toThrow();

      expect(mockClient.initialize).toHaveBeenCalledTimes(2);
    });

    it('does not reconnect for ordinary channel errors', async () => {
      const mockClient = await connectedClient();
      mockClient.getChats.mockResolvedValue([
        { name: 'some-other-chat', id: { _serialized: 'other@g.us' } },
      ]);

      await expect(service.getChannelMessages('missing')).rejects.toThrow(
        'not found',
      );
      expect(mockClient.initialize).not.toHaveBeenCalled();
    });
  });
  describe('deleteMessage', () => {
    /**
     * Regression: `delete(true)` resolves without error even when WhatsApp Web
     * does not carry out the revoke. The smoke test's source messages piled up
     * in the channel run after run while every layer reported "deleted".
     */
    async function connectedWithMessage(msg: unknown, afterDelete: unknown[]) {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.pupPage = { evaluate: jest.fn().mockResolvedValue([]) };
      const lookups = [msg, ...afterDelete];
      let call = 0;
      mockClient.getMessageById = jest.fn(async () =>
        call < lookups.length ? lookups[call++] : lookups[lookups.length - 1],
      );
      return mockClient;
    }

    it('sends delete-for-everyone first', async () => {
      const msg = { type: 'chat', delete: jest.fn().mockResolvedValue(undefined) };
      await connectedWithMessage(msg, [msg]);

      await expect(service.deleteMessage('wa-1')).resolves.toBe(true);
      expect(msg.delete).toHaveBeenCalledWith(true);
      expect(msg.delete).not.toHaveBeenCalledWith(false);
    });

    it('falls back to delete-for-me when delete-for-everyone throws', async () => {
      const msg = {
        type: 'chat',
        delete: jest.fn(async (everyone: boolean) => {
          if (everyone) throw new Error('past the revoke window');
        }),
      };
      await connectedWithMessage(msg, [msg]);

      await expect(service.deleteMessage('wa-1')).resolves.toBe(true);
      expect(msg.delete).toHaveBeenCalledWith(true);
      expect(msg.delete).toHaveBeenCalledWith(false);
    });

    it('returns false when both delete attempts throw', async () => {
      const msg = {
        type: 'chat',
        delete: jest.fn().mockRejectedValue(new Error('nope')),
      };
      await connectedWithMessage(msg, [msg]);

      await expect(service.deleteMessage('wa-1')).resolves.toBe(false);
    });

    it('returns false when the message cannot be found at all', async () => {
      await connectedWithMessage(undefined, [undefined]);

      await expect(service.deleteMessage('wa-1')).resolves.toBe(false);
    });
  });

  describe('findMessageIdsContaining', () => {
    /**
     * The smoke test's channel cleanup depends on this: getChannelMessages
     * drops the app's own outgoing messages and exposes no ids, so it cannot
     * be used to delete the approval card the app itself posted.
     */
    async function connectedWithMessages(messages: unknown[]) {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue(messages);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'Approvals', id: { _serialized: 'approvals@g.us' } },
      ]);
      return { evaluate };
    }

    it('returns ids of matching messages only', async () => {
      await connectedWithMessages([
        { id: 'wa-1', body: 'source [ps-smoke-test] run-1' },
        { id: 'wa-2', body: 'a real parent message' },
        { id: 'wa-3', body: 'card…\n[ps-smoke-test]\n\n— ParentSync' },
      ]);

      await expect(
        service.findMessageIdsContaining('Approvals', '[ps-smoke-test]'),
      ).resolves.toEqual(['wa-1', 'wa-3']);
    });

    it('asks the page to include the app’s own outgoing messages', async () => {
      const { evaluate } = await connectedWithMessages([]);

      await service.findMessageIdsContaining('Approvals', '[ps-smoke-test]');

      const fetchCall = evaluate.mock.calls.find((args) => args.length === 5);
      expect(fetchCall).toBeDefined();
      expect(fetchCall![4]).toBe(true);
    });

    /**
     * WhatsApp keeps a deleted message in the in-page store with its body
     * intact, so without this filter the smoke test re-deletes everything it
     * has ever removed — one more message on every run.
     */
    it('ignores messages already deleted for everyone', async () => {
      await connectedWithMessages([
        { id: 'wa-gone', body: '[ps-smoke-test] old run', isRevoked: true },
        { id: 'wa-live', body: '[ps-smoke-test] this run', isRevoked: false },
      ]);

      await expect(
        service.findMessageIdsContaining('Approvals', '[ps-smoke-test]'),
      ).resolves.toEqual(['wa-live']);
    });

    it('drops entries with no usable id', async () => {
      await connectedWithMessages([
        { id: '', body: '[ps-smoke-test] lost id' },
        { id: 'wa-9', body: '[ps-smoke-test] fine' },
      ]);

      await expect(
        service.findMessageIdsContaining('Approvals', '[ps-smoke-test]'),
      ).resolves.toEqual(['wa-9']);
    });

    it('never scans for an empty needle', async () => {
      const { evaluate } = await connectedWithMessages([
        { id: 'wa-1', body: 'anything' },
      ]);

      await expect(
        service.findMessageIdsContaining('Approvals', ''),
      ).resolves.toEqual([]);
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  describe('resolving a channel by contact name', () => {
    /**
     * Regression: one-to-one chats report a formatted phone number as their
     * name, so a channel configured as the person's name failed hourly with
     * WHATSAPP_CHANNEL_NOT_FOUND even though the conversation was open.
     */
    async function connectedWith(chats: unknown[], contacts: unknown[]) {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.pupPage = { evaluate: jest.fn().mockResolvedValue([]) };
      mockClient.getChats.mockResolvedValue(chats);
      mockClient.getContacts.mockResolvedValue(contacts);
      return mockClient;
    }

    const dentistChat = {
      name: '+972 52-825-1158',
      id: { server: 'c.us', user: '972528251158', _serialized: '972528251158@c.us' },
      fetchMessages: jest.fn().mockResolvedValue([]),
    };

    it('matches the address-book name when the chat title is a phone number', async () => {
      await connectedWith([dentistChat], [
        {
          id: { server: 'c.us', user: '972528251158', _serialized: '972528251158@c.us' },
          name: 'מרפאת שיניים דר לם',
          pushname: 'Dr Lam',
        },
      ]);

      await expect(
        service.getChannelMessages('מרפאת שיניים דר לם'),
      ).resolves.toEqual([]);
      expect(appErrorEmitter.emit).not.toHaveBeenCalled();
    });

    it.each(['shortName', 'pushname', 'verifiedName'])(
      'also matches on %s',
      async (field) => {
        await connectedWith([dentistChat], [
          {
            id: { server: 'c.us', user: '972528251158', _serialized: '972528251158@c.us' },
            [field]: 'Dental Clinic',
          },
        ]);

        await expect(
          service.getChannelMessages('Dental Clinic'),
        ).resolves.toEqual([]);
      },
    );

    it('maps a @lid contact id onto its @c.us chat', async () => {
      await connectedWith([dentistChat], [
        {
          id: { server: 'lid', user: '972528251158', _serialized: '972528251158@lid' },
          name: 'מרפאת שיניים דר לם',
        },
      ]);

      await expect(
        service.getChannelMessages('מרפאת שיניים דר לם'),
      ).resolves.toEqual([]);
    });

    it('prefers a direct chat-title match and never reads contacts', async () => {
      const client = await connectedWith(
        [{ ...dentistChat, name: 'כיתה ה2 הורים' }],
        [],
      );

      // The whatsapp-web.js mock is a module-level singleton, so its call
      // history carries over from earlier tests in this file.
      client.getContacts.mockClear();

      await service.getChannelMessages('כיתה ה2 הורים');
      expect(client.getContacts).not.toHaveBeenCalled();
    });

    it('still reports not-found when no contact matches either', async () => {
      await connectedWith([dentistChat], [
        { id: { _serialized: 'other@c.us' }, name: 'Someone Else' },
      ]);

      await expect(service.getChannelMessages('מרפאת שיניים דר לם')).rejects.toThrow(
        'not found',
      );
      expect(appErrorEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'WHATSAPP_CHANNEL_NOT_FOUND' }),
      );
    });

    it('reports not-found when the contact exists but has no open chat', async () => {
      await connectedWith(
        [],
        [
          {
            id: { _serialized: '972528251158@c.us', user: '972528251158' },
            name: 'מרפאת שיניים דר לם',
          },
        ],
      );

      await expect(service.getChannelMessages('מרפאת שיניים דר לם')).rejects.toThrow(
        'not found',
      );
    });

    it('does not fail the lookup when getContacts throws', async () => {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.pupPage = { evaluate: jest.fn().mockResolvedValue([]) };
      mockClient.getChats.mockResolvedValue([dentistChat]);
      mockClient.getContacts.mockRejectedValue(new Error('Store not available'));

      await expect(service.getChannelMessages('מרפאת שיניים דר לם')).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('serializeMsgKey', () => {
    const SERIALIZED =
      'true_120363407443598263@g.us_3EB0A87880D02F4D93C750_255524885028964@lid';

    it('passes a plain string through', () => {
      expect(serializeMsgKey(SERIALIZED)).toBe(SERIALIZED);
    });

    it('prefers an own _serialized property', () => {
      expect(serializeMsgKey({ _serialized: SERIALIZED })).toBe(SERIALIZED);
    });

    it('falls back to a MsgKey own toString()', () => {
      const key = Object.create({ toString: () => SERIALIZED });
      expect(serializeMsgKey(key)).toBe(SERIALIZED);
    });

    /**
     * The reaction bug: the puppeteer bridge JSON-serializes MsgKey, dropping
     * the `_serialized` prototype getter and leaving a plain object whose
     * toString() is Object.prototype's — i.e. "[object Object]".
     */
    it('rebuilds the key from the fields that survive JSON serialization', () => {
      const bridged = JSON.parse(
        JSON.stringify({
          fromMe: true,
          remote: { server: 'g.us', user: '120363407443598263' },
          id: '3EB0A87880D02F4D93C750',
          participant: { server: 'lid', user: '255524885028964' },
        }),
      );

      expect(String(bridged)).toBe('[object Object]');
      expect(serializeMsgKey(bridged)).toBe(SERIALIZED);
    });

    it('rebuilds a one-to-one key that has no participant', () => {
      expect(
        serializeMsgKey({
          fromMe: false,
          remote: { server: 'c.us', user: '972500000000' },
          id: '3EB0FF',
        }),
      ).toBe('false_972500000000@c.us_3EB0FF');
    });

    it('never returns the "[object Object]" sentinel', () => {
      expect(serializeMsgKey({})).toBe('');
      expect(serializeMsgKey({ fromMe: true, id: 'abc' })).toBe('');
      expect(serializeMsgKey(null)).toBe('');
      expect(serializeMsgKey(undefined)).toBe('');
    });
  });

  describe('message_reaction handling', () => {
    const SERIALIZED =
      'true_120363407443598263@g.us_3EB0A87880D02F4D93C750_255524885028964@lid';

    async function fireReaction(reaction: unknown) {
      const emitter = new EventEmitter2();
      const emit = jest.spyOn(emitter, 'emit');
      const svc = new WhatsAppService(emitter, appErrorEmitter);
      await svc.initialize();

      const { Client } = require('whatsapp-web.js');
      const handler = (Client as jest.Mock).mock.results
        .flatMap((r: any) => (r.value.on as jest.Mock).mock.calls)
        .filter(([event]: [string]) => event === 'message_reaction')
        .pop()?.[1];
      expect(handler).toBeDefined();

      handler(reaction);
      await svc.onModuleDestroy();
      return emit;
    }

    it('emits the rebuilt key when the bridge stripped _serialized', async () => {
      const emit = await fireReaction({
        msgId: JSON.parse(
          JSON.stringify({
            fromMe: true,
            remote: { server: 'g.us', user: '120363407443598263' },
            id: '3EB0A87880D02F4D93C750',
            participant: { server: 'lid', user: '255524885028964' },
          }),
        ),
        reaction: '👍',
        senderId: '255524885028964@lid',
        timestamp: 1234,
      });

      expect(emit).toHaveBeenCalledWith(
        'whatsapp.reaction',
        expect.objectContaining({ msgId: SERIALIZED, reaction: '👍' }),
      );
    });

    it('drops the reaction instead of emitting an unusable id', async () => {
      const emit = await fireReaction({
        msgId: {},
        reaction: '👍',
        senderId: '255524885028964@lid',
      });

      expect(emit).not.toHaveBeenCalledWith(
        'whatsapp.reaction',
        expect.anything(),
      );
    });
  });

  describe('MsgKey._serialized restoration', () => {
    const realWindow = (global as any).window;
    afterEach(() => {
      (global as any).window = realWindow;
    });

    async function capturePatches() {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);
      await service.getChannelMessages('class');
      return evaluate.mock.calls.filter((args) => args.length === 1).map((a) => a[0]);
    }

    /** Stand-in for WhatsApp Web's MsgKey: toString() works, _serialized gone. */
    function fakeMsgKeyModule() {
      function MsgKey(this: any, serialized: string) {
        this.serialized = serialized;
      }
      MsgKey.prototype.toString = function () {
        return this.serialized;
      };
      return MsgKey;
    }

    it('restores _serialized from toString() so message lookups resolve', async () => {
      const patches = await capturePatches();
      const MsgKey: any = fakeMsgKeyModule();
      (global as any).window = {
        require: (name: string) => (name === 'WAWebMsgKey' ? MsgKey : undefined),
      };

      const key = new MsgKey('true_120363407443598263@g.us_3EB0_255524885028964@lid');
      expect(key._serialized).toBeUndefined();

      patches.forEach((patch) => patch());

      expect(key._serialized).toBe(
        'true_120363407443598263@g.us_3EB0_255524885028964@lid',
      );
    });

    it('leaves a native _serialized untouched', async () => {
      const patches = await capturePatches();
      const MsgKey: any = fakeMsgKeyModule();
      Object.defineProperty(MsgKey.prototype, '_serialized', {
        configurable: true,
        get() {
          return 'native-value';
        },
      });
      (global as any).window = {
        require: (name: string) => (name === 'WAWebMsgKey' ? MsgKey : undefined),
      };

      patches.forEach((patch) => patch());

      expect(new MsgKey('ignored')._serialized).toBe('native-value');
    });

    it('is a no-op when the module loader is unavailable', async () => {
      const patches = await capturePatches();
      (global as any).window = {};
      expect(() => patches.forEach((patch) => patch())).not.toThrow();
    });

    /**
     * The reaction payload crosses the exposeFunction bridge as JSON, and a
     * prototype getter does not survive that. Stamping _serialized as an own
     * enumerable property is what keeps the approval lookup working.
     */
    it('stamps _serialized onto reaction keys so it survives JSON', async () => {
      const patches = await capturePatches();
      const MsgKey: any = fakeMsgKeyModule();
      const original = jest.fn();
      (global as any).window = {
        onReaction: original,
        require: (name: string) => (name === 'WAWebMsgKey' ? MsgKey : undefined),
      };

      patches.forEach((patch) => patch());

      const parentMsgKey = new MsgKey('true_1203634@g.us_3EB0_2555248@lid');
      (global as any).window.onReaction([{ parentMsgKey }]);

      expect(original).toHaveBeenCalledTimes(1);
      expect(
        Object.prototype.hasOwnProperty.call(parentMsgKey, '_serialized'),
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(parentMsgKey))._serialized).toBe(
        'true_1203634@g.us_3EB0_2555248@lid',
      );
    });

    it('does not stamp the "[object Object]" sentinel', async () => {
      const patches = await capturePatches();
      const original = jest.fn();
      (global as any).window = { onReaction: original };

      patches.forEach((patch) => patch());

      const parentMsgKey = {};
      (global as any).window.onReaction([{ parentMsgKey }]);

      expect(original).toHaveBeenCalledTimes(1);
      expect(
        Object.prototype.hasOwnProperty.call(parentMsgKey, '_serialized'),
      ).toBe(false);
    });

    it('wraps onReaction only once', async () => {
      const patches = await capturePatches();
      const original = jest.fn();
      (global as any).window = { onReaction: original };

      patches.forEach((patch) => patch());
      const wrapped = (global as any).window.onReaction;
      patches.forEach((patch) => patch());

      expect((global as any).window.onReaction).toBe(wrapped);
    });
  });

  /**
   * Every approval card is sent with an .ics attachment, so a break in the
   * media path takes out approvals entirely while plain-text sends keep
   * working — which is exactly how this surfaced in production.
   */
  describe('MediaPrep __x_id leak', () => {
    const realWindow = (global as any).window;
    afterEach(() => {
      (global as any).window = realWindow;
    });

    async function capturePatches() {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      const evaluate = jest.fn().mockResolvedValue([]);
      mockClient.pupPage = { evaluate };
      mockClient.getChats.mockResolvedValue([
        { name: 'class', id: { _serialized: 'class@g.us' } },
      ]);
      await service.getChannelMessages('class');
      return evaluate.mock.calls
        .filter((args) => args.length === 1)
        .map((a) => a[0]);
    }

    /**
     * Stands in for WhatsApp Web's MediaPrep: field values live in private
     * `__x_<name>` properties, and `__x_id` holds the "unset" sentinel until
     * something reads `.id`.
     */
    function fakeMediaPrep() {
      return {
        __x_id: { sentinel: true },
        __x_mimetype: 'text/calendar',
        __x_filename: 'event.ics',
      };
    }

    function windowWith(processMediaData: unknown) {
      const win: any = { WWebJS: { processMediaData } };
      (global as any).window = win;
      return win;
    }

    /**
     * WhatsApp Web's model constructor takes the private `__x_id` backing
     * field in preference to the public `id` — that precedence is the whole
     * bug, so the test has to reproduce it rather than assert on the spread.
     */
    function idSeenByMsgModel(data: any): unknown {
      return '__x_id' in data ? data.__x_id : data.id;
    }

    it("keeps the message id whatsapp-web.js set, instead of MediaPrep's", async () => {
      const patches = await capturePatches();
      const win = windowWith(jest.fn().mockResolvedValue(fakeMediaPrep()));
      const msgKey = { _serialized: 'true_class@g.us_3EB0_me@lid' };

      // Unpatched: the spread carries __x_id in, and the model reads that.
      const before = { id: msgKey, ...(await win.WWebJS.processMediaData()) };
      expect(idSeenByMsgModel(before)).toEqual({ sentinel: true });

      patches.forEach((patch) => patch());

      const after = { id: msgKey, ...(await win.WWebJS.processMediaData()) };
      expect(idSeenByMsgModel(after)).toBe(msgKey);
    });

    it('still carries the media metadata into the message', async () => {
      const patches = await capturePatches();
      const win = windowWith(jest.fn().mockResolvedValue(fakeMediaPrep()));

      patches.forEach((patch) => patch());
      const spread: any = { ...(await win.WWebJS.processMediaData()) };

      // Only __x_id collides with the message; the rest is how the attachment
      // reaches WhatsApp at all.
      expect(spread.__x_mimetype).toBe('text/calendar');
      expect(spread.__x_filename).toBe('event.ics');
    });

    it('leaves the field readable on the prep itself', async () => {
      const patches = await capturePatches();
      const win = windowWith(jest.fn().mockResolvedValue(fakeMediaPrep()));

      patches.forEach((patch) => patch());
      const result: any = await win.WWebJS.processMediaData();

      // Hidden from enumeration, not removed — MediaPrep reads it back through
      // its own `id` accessor.
      expect(result.__x_id).toEqual({ sentinel: true });
      expect(Object.keys(result)).not.toContain('__x_id');
    });

    it('passes the caller arguments through untouched', async () => {
      const patches = await capturePatches();
      const processMediaData = jest.fn().mockResolvedValue(fakeMediaPrep());
      const win = windowWith(processMediaData);

      patches.forEach((patch) => patch());
      await win.WWebJS.processMediaData(
        { mimetype: 'text/calendar' },
        { forceDocument: true },
      );

      expect(processMediaData).toHaveBeenCalledWith(
        { mimetype: 'text/calendar' },
        { forceDocument: true },
      );
    });

    it('is a no-op on a build that never leaked the field', async () => {
      const patches = await capturePatches();
      const prep: any = { __x_mimetype: 'image/png' };
      const win = windowWith(jest.fn().mockResolvedValue(prep));

      patches.forEach((patch) => patch());

      await expect(win.WWebJS.processMediaData()).resolves.toBe(prep);
    });

    it('wraps processMediaData only once', async () => {
      const patches = await capturePatches();
      const win = windowWith(jest.fn().mockResolvedValue(fakeMediaPrep()));

      patches.forEach((patch) => patch());
      const wrapped = win.WWebJS.processMediaData;
      patches.forEach((patch) => patch());

      expect(win.WWebJS.processMediaData).toBe(wrapped);
    });

    it('does not throw when WWebJS is not injected yet', async () => {
      const patches = await capturePatches();
      (global as any).window = {};

      expect(() => patches.forEach((patch) => patch())).not.toThrow();
    });
  });

  describe('send result lost by whatsapp-web.js', () => {
    async function connectedClient(sendResult: unknown) {
      await service.initialize();
      const { Client } = require('whatsapp-web.js');
      const mockClient = new Client();
      mockClient.pupPage = { evaluate: jest.fn().mockResolvedValue([]) };
      const chat = {
        name: 'approvals',
        id: { _serialized: 'approvals@g.us' },
        sendMessage: jest.fn().mockResolvedValue(sendResult),
        markUnread: jest.fn().mockResolvedValue(undefined),
      };
      mockClient.getChats.mockResolvedValue([chat]);
      return { mockClient, chat };
    }

    it('reports a readable error instead of a TypeError when the send result is lost', async () => {
      const { chat } = await connectedClient(undefined);

      await expect(service.sendMessage('approvals', 'hello')).rejects.toThrow(
        /could not read it back/i,
      );
      // The message did leave — the failure is the lookup afterwards.
      expect(chat.sendMessage).toHaveBeenCalledWith('hello');
    });

    it('does not surface "Cannot read properties of undefined"', async () => {
      await connectedClient(undefined);

      await expect(
        service.sendMessage('approvals', 'hello'),
      ).rejects.not.toThrow(/Cannot read properties of undefined/);
    });

    it('returns the message id on a normal send', async () => {
      await connectedClient({ id: { _serialized: 'true_approvals@g.us_ABC' } });

      await expect(service.sendMessage('approvals', 'hello')).resolves.toBe(
        'true_approvals@g.us_ABC',
      );
    });

    it('falls back to the stringified key when _serialized is missing', async () => {
      await connectedClient({
        id: { toString: () => 'true_approvals@g.us_XYZ' },
      });

      await expect(service.sendMessage('approvals', 'hello')).resolves.toBe(
        'true_approvals@g.us_XYZ',
      );
    });
  });
});
