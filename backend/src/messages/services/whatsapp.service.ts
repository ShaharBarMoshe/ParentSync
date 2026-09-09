import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Chat, Contact, Message, MessageMedia, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import {
  IWhatsAppService,
  WhatsAppMessage,
  WhatsAppMessageImage,
  WhatsAppMedia,
  WhatsAppConnectionStatus,
} from '../interfaces/whatsapp-service.interface';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';
import { SMOKE_TEST_MARKER } from '../../shared/constants/smoke-test';
import { UNUSABLE_APPROVAL_MESSAGE_ID } from '../../shared/utils/approval-message-id';

/**
 * Rebuild the canonical `fromMe_remote_id[_participant]` WhatsApp message key
 * from whatever survived the page boundary.
 *
 * whatsapp-web.js hands the `message_reaction` event the raw
 * `reactionParentKey` — a MsgKey *instance* living inside the page. Puppeteer
 * JSON-serializes it on the way to Node, and `_serialized` is a prototype
 * getter (see `ensureBrowserPatches`), so it is stripped: what lands here is a
 * plain object with no `toString()` of its own. Calling `toString()` on that
 * returns the literal string "[object Object]", which then matched any row
 * holding the same sentinel and silently approved the wrong event.
 *
 * Returns '' when nothing usable is left, so the caller can drop the reaction
 * loudly instead of looking one up with garbage.
 */
export function serializeMsgKey(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object') return '';

  const key = raw as Record<string, any>;

  if (typeof key._serialized === 'string' && key._serialized.trim()) {
    return key._serialized.trim();
  }

  // A genuine MsgKey overrides toString(); a plain object inherits
  // Object.prototype.toString, which only ever yields the sentinel.
  if (
    typeof key.toString === 'function' &&
    key.toString !== Object.prototype.toString
  ) {
    const viaToString = String(key.toString()).trim();
    if (viaToString && viaToString !== UNUSABLE_APPROVAL_MESSAGE_ID) {
      return viaToString;
    }
  }

  // Nested Wid objects lose `_serialized` to the same prototype-getter
  // problem, but keep `user`/`server`.
  const wid = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const w = value as Record<string, any>;
    if (typeof w._serialized === 'string' && w._serialized.trim()) {
      return w._serialized.trim();
    }
    return w.user && w.server ? `${w.user}@${w.server}` : '';
  };

  const remote = wid(key.remote);
  const id = typeof key.id === 'string' ? key.id.trim() : '';
  if (!remote || !id) return '';

  const parts = [key.fromMe ? 'true' : 'false', remote, id];
  const participant = wid(key.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

@Injectable()
export class WhatsAppService
  implements IWhatsAppService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsAppService.name);
  private client: Client | null = null;
  private connected = false;
  private connectionStatus: WhatsAppConnectionStatus = 'disconnected';
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly appErrorEmitter: AppErrorEmitterService,
  ) {}

  onModuleInit(): void {
    this.initialize().catch((error) => {
      this.logger.error(
        `WhatsApp client failed to initialize on startup: ${error.message}. Will retry on next sync.`,
      );
    });
  }

  async initialize(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.initPromise) {
      this.logger.log('WhatsApp initialization already in progress, waiting...');
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private getWhatsAppDataDir(): string {
    return process.env.WHATSAPP_DATA_DIR || path.join(os.homedir(), '.parentsync', 'whatsapp-session');
  }

  private removeStaleLocks(): void {
    const sessionDir = path.join(this.getWhatsAppDataDir(), 'session');
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of lockFiles) {
      const lockPath = path.join(sessionDir, file);
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          this.logger.warn(`Removed stale Chrome ${file}`);
        }
      } catch {
        // Ignore — file may not exist or already removed
      }
    }
  }

  private async destroyClient(client: Client): Promise<void> {
    try {
      await client.destroy();
    } catch {
      // destroy() failed — force-kill the underlying browser process
      try {
        const browser = (client as any).pupBrowser;
        if (browser) {
          const proc = browser.process();
          if (proc) {
            this.logger.warn('Force-killing lingering Chrome process');
            proc.kill('SIGKILL');
          }
        }
      } catch { /* best effort */ }
    }
  }

  private async doInitialize(): Promise<void> {
    if (this.client) {
      await this.destroyClient(this.client);
      this.client = null;
    }

    this.removeStaleLocks();
    this.logger.log('Initializing whatsapp-web.js client...');

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.getWhatsAppDataDir() }),
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
        ],
      },
    });

    this.setStatus('connecting');

    this.client.on('authenticated', () => {
      this.logger.log('WhatsApp client authenticated successfully');
      this.setStatus('authenticated');
    });

    this.client.on('ready', () => {
      this.connected = true;
      this.setStatus('connected');
      this.logger.log('WhatsApp client is ready');
    });

    this.client.on('qr', (qr) => {
      this.setStatus('waiting_for_qr');
      this.logger.warn('Scan this QR code with WhatsApp on your phone:');
      qrcode.generate(qr, { small: true });
      // Emit QR string for in-app display
      this.eventEmitter.emit('whatsapp.qr', qr);
    });

    this.client.on('disconnected', (reason) => {
      this.connected = false;
      this.setStatus('disconnected');
      this.logger.warn(`WhatsApp client disconnected: ${reason}`);
    });

    this.client.on('auth_failure', (msg) => {
      this.connected = false;
      this.setStatus('disconnected');
      this.logger.error(`WhatsApp authentication failed: ${msg}`);
    });

    this.client.on('message_reaction', (reaction: any) => {
      const msgId = serializeMsgKey(reaction?.msgId);
      if (!msgId) {
        // Never fall through with an unusable id: it used to match whichever
        // row stored the same "[object Object]" sentinel, so a 👍 approved an
        // unrelated event instead of the one the user reacted to.
        this.logger.warn(
          `Dropping reaction "${reaction?.reaction ?? ''}" from ` +
            `${reaction?.senderId ?? 'unknown'} — its parent message key did ` +
            `not survive the page boundary. Approval cannot be matched.`,
        );
        return;
      }

      this.eventEmitter.emit('whatsapp.reaction', {
        msgId,
        reaction: reaction.reaction || '',
        senderId: reaction.senderId || '',
        timestamp: reaction.timestamp || Date.now(),
      });
    });

    try {
      await this.client.initialize();
      this.logger.log('WhatsApp client initialized — waiting for ready...');

      if (!this.connected) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.logger.error('WhatsApp client did not become ready within 90 seconds');
            reject(new Error('WhatsApp client did not become ready within 90s'));
          }, 90_000);

          this.client!.once('ready', () => { clearTimeout(timeout); resolve(); });
          this.client!.once('auth_failure', (msg) => {
            clearTimeout(timeout);
            this.logger.error(`WhatsApp authentication failed during init: ${msg}`);
            reject(new Error(`Auth failed: ${msg}`));
          });
        });
      }
    } catch (error) {
      this.logger.error(`Failed to initialize WhatsApp client: ${error.message}`);
      this.setStatus('disconnected');
      this.appErrorEmitter.emit({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_INIT_FAILED,
        message:
          'WhatsApp Web could not connect. Open Settings → WhatsApp to scan a fresh QR code.',
      });
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionStatus(): WhatsAppConnectionStatus {
    return this.connectionStatus;
  }

  private setStatus(status: WhatsAppConnectionStatus): void {
    this.connectionStatus = status;
    this.eventEmitter.emit('whatsapp.status', status);
  }

  private normalizeText(text: string): string {
    return text
      .normalize('NFC')
      .replace(/[\u05F4\u201C\u201D\u201E]/g, '"') // Hebrew gershayim + smart quotes → "
      .replace(/[\u05F3\u2018\u2019\u201A]/g, "'") // Hebrew geresh + smart apostrophes → '
      .replace(/\u200F/g, '') // Remove RTL marks
      .replace(/\s+/g, ' ')  // Collapse whitespace
      .trim()
      .toLowerCase();
  }

  private async findChatByName(chatName: string): Promise<Chat> {
    if (!this.connected || !this.client) {
      throw new Error(
        'WhatsApp client is not connected. Call initialize() first.',
      );
    }

    await this.ensureBrowserPatches();

    const chats: Chat[] = await this.client.getChats();
    const normalizedTarget = this.normalizeText(chatName);
    let targetChat = chats.find(
      (chat) => this.normalizeText(chat.name) === normalizedTarget,
    );

    // A one-to-one chat usually reports a phone number as its name, so a
    // channel configured by the contact's name misses here. Resolve it through
    // the contact list before giving up.
    if (!targetChat) {
      targetChat = await this.findChatByContactName(chats, normalizedTarget);
    }

    if (!targetChat) {
      const chatNames = chats.map((c) => c.name).slice(0, 50);
      this.logger.warn(
        `Channel "${chatName}" not found among ${chats.length} chats ` +
          `(no chat title or contact name matched). First 50 titles: ` +
          `${JSON.stringify(chatNames)}`,
      );
      this.appErrorEmitter.emit({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_CHANNEL_NOT_FOUND,
        message: `WhatsApp channel "${chatName}" was not found. Verify the channel name in Settings — it must match exactly.`,
      });
      throw new Error(`Channel "${chatName}" not found`);
    }

    return targetChat;
  }

  /**
   * Resolve a chat by the *contact* name WhatsApp shows for it.
   *
   * `Chat.name` is whatsapp-web.js's `formattedTitle`. For a group that is the
   * group's own title, so a direct match works. For a one-to-one chat the
   * title has to be resolved through WhatsApp Web's contact store, and in
   * practice it comes back as a formatted phone number ("+972 52-825-1158")
   * for every private chat — so a channel configured as the person's name
   * ("מרפאת שיניים דר לם") never matched and failed hourly with
   * WHATSAPP_CHANNEL_NOT_FOUND.
   *
   * Contacts carry the address-book name (`name`) plus `shortName`,
   * `pushname` and a business account's `verifiedName`; match on any of them,
   * then map back to the open chat by id. Runs only after a direct title match
   * has already missed, so the extra call costs nothing in the common case.
   */
  private async findChatByContactName(
    chats: Chat[],
    normalizedTarget: string,
  ): Promise<Chat | undefined> {
    let contacts: Contact[];
    try {
      contacts = await this.client!.getContacts();
    } catch (error) {
      // Not fatal — the caller still reports the channel as not found, and
      // this says why the fallback could not help.
      this.logger.warn(
        `Could not read WhatsApp contacts while resolving a channel by ` +
          `contact name: ${(error as Error).message}`,
      );
      return undefined;
    }

    const namesOf = (contact: Contact): string[] =>
      [contact.name, contact.shortName, contact.pushname, contact.verifiedName]
        .filter((name): name is string => typeof name === 'string' && !!name);

    const matches = contacts.filter((contact) =>
      namesOf(contact).some(
        (name) => this.normalizeText(name) === normalizedTarget,
      ),
    );

    if (matches.length === 0) {
      // Distinguish "this name is not in the address book" from "WhatsApp Web
      // gave us no contact names at all" — the second is the reason chat
      // titles degrade to phone numbers, and needs a different fix.
      const named = contacts.filter((c) => namesOf(c).length > 0).length;
      this.logger.warn(
        `No contact name matched. Scanned ${contacts.length} contacts, ` +
          `${named} of which carry a name.`,
      );
      return undefined;
    }

    for (const contact of matches) {
      const chat = chats.find((c) => this.isSameWid(c.id, contact.id));
      if (chat) {
        this.logger.log(
          `Resolved channel by contact name → chat "${chat.name}" ` +
            `(${this.serializeWid(chat.id) || 'unknown id'})`,
        );
        return chat;
      }
    }

    // The contact exists but has no open chat — a different problem from a
    // misspelled channel name, and worth saying so.
    this.logger.warn(
      `Contact matched the configured channel name, but no open chat was ` +
        `found for it (${matches.length} matching contact(s)). Open the ` +
        `conversation in WhatsApp so it appears in the chat list.`,
    );
    return undefined;
  }

  /** `@lid` and `@c.us` forms of the same id differ, so compare both. */
  private isSameWid(a: unknown, b: unknown): boolean {
    const serializedA = this.serializeWid(a);
    const serializedB = this.serializeWid(b);
    if (serializedA && serializedA === serializedB) return true;

    const userA = this.widUser(a);
    const userB = this.widUser(b);
    return !!userA && userA === userB;
  }

  private serializeWid(id: unknown): string {
    if (typeof id === 'string') return id;
    const wid = id as Record<string, any> | null;
    if (!wid || typeof wid !== 'object') return '';
    if (typeof wid._serialized === 'string' && wid._serialized) {
      return wid._serialized;
    }
    return wid.user && wid.server ? `${wid.user}@${wid.server}` : '';
  }

  private widUser(id: unknown): string {
    const serialized = this.serializeWid(id);
    return serialized ? serialized.split('@')[0] : '';
  }

  /**
   * WhatsApp Web changed the shape of `Chat.lastReceivedKey`: the object is
   * still present but its `_serialized` is now undefined. whatsapp-web.js's
   * `getChatModel` only null-checks the outer object, then hands that undefined
   * id to IndexedDB, which throws `DataError: No key or key range specified`.
   * Because `getChats()` resolves every chat through `Promise.all`, one bad
   * chat rejects the whole call — in practice all of them — so every channel
   * lookup failed.
   *
   * Rather than reimplement `getChatModel` (and drift from upstream), hide the
   * malformed field behind a Proxy so the original takes its own `: null`
   * branch. Idempotent and tagged on the function itself, so it re-applies
   * after WhatsApp Web reloads and whatsapp-web.js reinjects its helpers.
   *
   * The second patch restores `MsgKey#_serialized`, which WhatsApp Web removed
   * outright — `toString()` still returns the identical string. Without it
   * `Msg.get(key._serialized)` is `Msg.get(undefined)` and misses every time,
   * which made `chat.sendMessage()` resolve to `undefined` (the message was
   * delivered, only the lookup of it failed) and left every scraped message
   * with an empty id. Patching the prototype fixes every `_serialized` read at
   * once, including the ones inside whatsapp-web.js itself.
   *
   * The last patch does for `window.onReaction` what the second does for
   * `getMessageModel`: reaction payloads carry raw MsgKey instances across the
   * exposeFunction bridge, so their id needs to be stamped on as an own
   * property before JSON serialization strips the prototype getter. Without
   * it every approval reaction arrived as "[object Object]".
   */
  private async ensureBrowserPatches(): Promise<void> {
    const page = (this.client as any)?.pupPage;
    if (!page?.evaluate) return;

    try {
      await page.evaluate(() => {
        const win = window as any;
        const wwebjs = win.WWebJS;
        if (!wwebjs?.getChatModel || wwebjs.getChatModel.__parentSyncPatched) {
          return;
        }

        const original = wwebjs.getChatModel;
        const patched = async (chat: any, options: any) => {
          if (
            chat?.lastReceivedKey &&
            chat.lastReceivedKey._serialized === undefined
          ) {
            chat = new Proxy(chat, {
              get(target: any, prop: string | symbol) {
                if (prop === 'lastReceivedKey') return undefined;
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          }
          return original(chat, options);
        };
        patched.__parentSyncPatched = true;
        wwebjs.getChatModel = patched;
      });

      await page.evaluate(() => {
        const win = window as any;
        const wwebjs = win.WWebJS;
        if (!wwebjs?.getMessageModel || wwebjs.getMessageModel.__parentSyncPatched) {
          return;
        }

        // The prototype getter below fixes `_serialized` inside the page, but
        // page.evaluate returns plain JSON to Node and JSON.stringify does not
        // walk prototype getters — so the id would still arrive without it.
        // Stamp it as an own property on the way out.
        const original = wwebjs.getMessageModel;
        const patched = (message: any) => {
          const model = original(message);
          if (
            model?.id &&
            typeof model.id === 'object' &&
            model.id._serialized === undefined
          ) {
            const serialized = message?.id?.toString?.();
            if (serialized && serialized !== '[object Object]') {
              model.id._serialized = serialized;
            }
          }
          return model;
        };
        patched.__parentSyncPatched = true;
        wwebjs.getMessageModel = patched;
      });

      await page.evaluate(() => {
        const win = window as any;
        const original = win.onReaction;
        if (typeof original !== 'function' || original.__parentSyncPatched) {
          return;
        }

        // Reactions hit the same prototype-getter problem as getMessageModel
        // above: whatsapp-web.js passes the raw MsgKey instances to
        // window.onReaction, and the exposeFunction bridge JSON-serializes
        // them — dropping `_serialized`, which is a getter on the prototype
        // (restored below, and by WhatsApp Web itself on older builds).
        // Stamp the string as an *own enumerable* property so it survives.
        const stamp = (key: any) => {
          if (!key || typeof key !== 'object') return;
          if (Object.prototype.hasOwnProperty.call(key, '_serialized')) return;
          const serialized = key.toString?.();
          if (!serialized || serialized === '[object Object]') return;
          Object.defineProperty(key, '_serialized', {
            value: serialized,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        };

        const patched = (reactions: any) => {
          if (Array.isArray(reactions)) {
            for (const reaction of reactions) {
              stamp(reaction?.parentMsgKey);
              stamp(reaction?.msgKey);
            }
          }
          return original(reactions);
        };
        patched.__parentSyncPatched = true;
        win.onReaction = patched;
      });

      await page.evaluate(() => {
        const win = window as any;
        if (typeof win.require !== 'function') return;

        const MsgKey = win.require('WAWebMsgKey');
        const proto = MsgKey?.prototype;
        if (!proto || typeof proto.toString !== 'function') return;
        if (Object.getOwnPropertyDescriptor(proto, '_serialized')) return;

        // WhatsApp Web dropped the `_serialized` getter from MsgKey; the same
        // string is still available from toString(). Restore the property so
        // every `key._serialized` read across whatsapp-web.js keeps working.
        Object.defineProperty(proto, '_serialized', {
          configurable: true,
          get() {
            return this.toString();
          },
        });
      });
    } catch (error) {
      // Never block the lookup on this — a WhatsApp Web build without the bug
      // works fine unpatched, and getChats() will report its own failure.
      this.logger.warn(
        `Could not apply WhatsApp Web compatibility patch: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Errors that mean the underlying Puppeteer page or browser is gone. These
   * never fire whatsapp-web.js's 'disconnected' event, so without this check
   * `connected` stays true and every later call fails until a manual reconnect.
   */
  private static readonly SESSION_DEAD_PATTERNS = [
    'detached frame',
    'session closed',
    'target closed',
    'execution context was destroyed',
    'protocol error',
    'page has been closed',
    'browser has disconnected',
  ];

  private isSessionDeadError(error: unknown): boolean {
    const message = (error as Error)?.message?.toLowerCase() ?? '';
    return WhatsAppService.SESSION_DEAD_PATTERNS.some((pattern) =>
      message.includes(pattern),
    );
  }

  /**
   * Run a WhatsApp operation, and when it fails because the browser session
   * died, re-initialize once and retry. `reconnectedThisCycle` caps this at one
   * reconnect per sync cycle (SyncService resets it) so a permanently broken
   * session cannot relaunch Chromium once per channel.
   */
  private async withSessionRecovery<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!this.isSessionDeadError(error)) throw error;

      this.logger.warn(
        `WhatsApp browser session is dead while ${operation}: ${(error as Error).message}`,
      );
      this.connected = false;
      this.setStatus('disconnected');

      if (this.reconnectedThisCycle) {
        this.logger.warn(
          'Already attempted a WhatsApp reconnect this cycle — not retrying',
        );
        throw error;
      }
      this.reconnectedThisCycle = true;

      this.logger.log('Re-initializing WhatsApp client after dead session...');
      await this.initialize();
      return run();
    }
  }

  private reconnectedThisCycle = false;

  /** Call at the start of each sync cycle to allow one reconnect attempt. */
  resetReconnectFlag(): void {
    this.reconnectedThisCycle = false;
  }

  /**
   * Read messages directly from the in-memory chat store via pupPage.evaluate,
   * bypassing Chat.fetchMessages() which breaks when WhatsApp Web removes or
   * renames internal functions like waitForChatLoading.
   *
   * Resolved through WhatsApp Web's own module loader: whatsapp-web.js dropped
   * its `window.Store` bridge in 1.34, so the old `win.Store.*` reads threw on
   * every call and silently fell back to the fetchMessages() path this method
   * exists to avoid. `win.Store` is still honoured when present.
   */
  private async fetchMessagesDirectly(
    chatId: string,
    limit: number,
    options: { includeOwnMessages?: boolean } = {},
  ): Promise<Array<{ id: string; body: string; isRevoked?: boolean; timestamp: number; author?: string; from: string; hasMedia: boolean; mediaType?: string }>> {
    if (!this.client) {
      throw new Error('WhatsApp client is not connected.');
    }

    const page = (this.client as any).pupPage;
    if (!page) {
      throw new Error('Puppeteer page not available.');
    }

    return page.evaluate(
      async (
        serializedChatId: string,
        msgLimit: number,
        smokeMarker: string,
        includeOwn: boolean,
      ) => {
        const win = window as any;
        const load =
          typeof win.require === 'function'
            ? (moduleName: string) => win.require(moduleName)
            : null;

        const widFactory = load ? load('WAWebWidFactory') : win.Store?.WidFactory;
        const chatCollection = load
          ? load('WAWebCollections')?.Chat
          : win.Store?.Chat;
        const findChatAction = load
          ? load('WAWebFindChatAction')
          : win.Store?.FindOrCreateChat;

        if (!widFactory?.createWid || !chatCollection?.get) {
          throw new Error(
            'WhatsApp Web internals unavailable (WAWebWidFactory/WAWebCollections)',
          );
        }

        const chatWid = widFactory.createWid(serializedChatId);
        const chat =
          chatCollection.get(chatWid) ||
          (await findChatAction?.findOrCreateLatestChat(chatWid))?.chat;

        if (!chat || !chat.msgs) return [];

        const msgs = chat.msgs
          .getModelsArray()
          // Drop the app's own outgoing messages — except smoke-test messages,
          // which the production smoke test must read back through this scrape.
          .filter(
            (m: any) =>
              !m.isNotification &&
              (includeOwn ||
                !m.isSentByMe ||
                (typeof m.body === 'string' &&
                  m.body.includes(smokeMarker))),
          )
          .sort((a: any, b: any) => b.t - a.t)
          .slice(0, msgLimit);

        return msgs.map((m: any) => {
          // Serialize sender to a string — may be an object with _serialized
          const rawAuthor = m.author;
          const rawFrom = m.id?.remote;
          const author = typeof rawAuthor === 'object' && rawAuthor?._serialized
            ? rawAuthor._serialized
            : (typeof rawAuthor === 'string' ? rawAuthor : undefined);
          const from = typeof rawFrom === 'object' && rawFrom?._serialized
            ? rawFrom._serialized
            : (typeof rawFrom === 'string' ? rawFrom : '');
          const id =
            m.id?._serialized ||
            (typeof m.id === 'string'
              ? m.id
              : typeof m.id?.toString === 'function'
                ? m.id.toString()
                : '');

          return {
            id,
            body: m.body || '',
            // Deleted-for-everyone messages stay in the store with their body
            // intact. WhatsApp has spelled this several ways across builds, so
            // check all of them rather than trusting one field.
            isRevoked:
              m.type === 'revoked' ||
              m.subtype === 'revoke' ||
              m.isRevokedByMe === true ||
              m.isDeleted === true ||
              !!m.revokeTimestamp ||
              !!m.revokeSender ||
              (typeof m.type === 'string' && m.type.indexOf('revoke') !== -1),
            timestamp: m.t,
            author,
            from,
            hasMedia: !!(m.mediaData || m.type === 'image' || m.type === 'video'
              || m.type === 'audio' || m.type === 'document' || m.type === 'sticker'),
            mediaType: typeof m.type === 'string' ? m.type : undefined,
          };
        });
      },
      chatId,
      limit,
      SMOKE_TEST_MARKER,
      options.includeOwnMessages === true,
    );
  }

  async getChannelMessages(
    channelName: string,
    limit = 50,
  ): Promise<WhatsAppMessage[]> {
    return this.withSessionRecovery(`reading channel "${channelName}"`, () =>
      this.readChannelMessages(channelName, limit),
    );
  }

  private async readChannelMessages(
    channelName: string,
    limit = 50,
  ): Promise<WhatsAppMessage[]> {
    const targetChat = await this.findChatByName(channelName);
    const chatId = (targetChat as any).id?._serialized;

    let rawMessages: Array<{ id: string; body: string; timestamp: number; author?: string; from: string; hasMedia: boolean; mediaType?: string }>;
    try {
      rawMessages = await this.fetchMessagesDirectly(chatId, limit);
    } catch (error) {
      this.logger.warn(
        `Direct message fetch failed for "${channelName}", falling back to fetchMessages: ${error.message}`,
      );
      // Fallback to original fetchMessages — also handles image media here
      try {
        const messages = await targetChat.fetchMessages({ limit });
        const out: WhatsAppMessage[] = [];
        for (const msg of messages) {
          const isImage = msg.hasMedia && msg.type === 'image';
          const hasText = !!(msg.body && msg.body.trim().length > 0);
          if (!hasText && !isImage) continue;
          let images: WhatsAppMessageImage[] | undefined;
          if (isImage) {
            const downloaded = await this.tryDownloadImage(msg);
            if (downloaded) images = [downloaded];
          }
          out.push({
            content: msg.body || '',
            timestamp: new Date(msg.timestamp * 1000),
            sender: msg.author || msg.from,
            channel: channelName,
            images,
          });
        }
        return out;
      } catch (fallbackError) {
        // A dead browser session must reach withSessionRecovery — swallowing it
        // here would report "no messages" forever instead of reconnecting.
        if (this.isSessionDeadError(fallbackError)) throw fallbackError;

        this.logger.warn(
          `Failed to fetch messages from "${channelName}": ${fallbackError.message}`,
        );
        this.appErrorEmitter.emit({
          source: 'whatsapp',
          code: AppErrorCodes.WHATSAPP_FETCH_FAILED,
          message: `Could not read messages from one or more WhatsApp channels. ParentSync will retry on the next sync.`,
        });
        return [];
      }
    }

    // Keep messages with text OR an image; drop media types we can't use
    // (videos, audio, documents, stickers) and pseudo-text base64 bodies.
    const kept = rawMessages.filter((msg) => {
      const isImage = msg.hasMedia && msg.mediaType === 'image';
      const hasText = !!(msg.body && msg.body.trim().length > 0);
      if (!hasText && !isImage) return false;
      // Skip messages whose body is raw base64 data (not user text)
      if (msg.hasMedia && hasText && msg.body.length > 200 && !/\s/.test(msg.body.slice(0, 100))) {
        // Pure-base64 caption is junk — keep the image, drop the body
        msg.body = '';
        return isImage;
      }
      return true;
    });

    const result: WhatsAppMessage[] = [];
    for (const msg of kept) {
      let images: WhatsAppMessageImage[] | undefined;
      if (msg.hasMedia && msg.mediaType === 'image' && msg.id) {
        const downloaded = await this.tryDownloadImageById(msg.id);
        if (downloaded) images = [downloaded];
      }

      // An image message whose download failed carries nothing: no text, no
      // picture. Storing it produced blank rows that still joined a proximity
      // group and diluted the merged content sent to the LLM. Drop it and say
      // so, rather than persisting a message with no content at all.
      const hasText = !!msg.body?.trim();
      if (!hasText && !images?.length) {
        this.logger.warn(
          `Dropping empty message from "${channelName}" (id=${msg.id || 'unknown'}, type=${msg.mediaType ?? 'none'}): no text and no downloadable image`,
        );
        continue;
      }

      result.push({
        content: msg.body || '',
        timestamp: new Date(msg.timestamp * 1000),
        sender: msg.author || msg.from,
        channel: channelName,
        images,
      });
    }
    return result;
  }

  // Cap matches Gemini's effective inline-image limit and keeps SQLite DB
  // bounded — most WhatsApp images compress well below this. Larger images
  // are dropped with a warning rather than silently sent.
  private static readonly MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  private async tryDownloadImageById(messageId: string): Promise<WhatsAppMessageImage | null> {
    if (!this.client) return null;
    try {
      const msg = await this.client.getMessageById(messageId);
      if (!msg) return null;
      return this.tryDownloadImage(msg);
    } catch (error) {
      this.logger.warn(
        `Failed to load message ${messageId} for image download: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async tryDownloadImage(msg: Message): Promise<WhatsAppMessageImage | null> {
    try {
      const media = await msg.downloadMedia();
      if (!media || !media.data || !media.mimetype) return null;
      // Roughly base64 → bytes (3 bytes per 4 chars). Avoid decoding for size.
      const approxBytes = Math.floor((media.data.length * 3) / 4);
      if (approxBytes > WhatsAppService.MAX_IMAGE_BYTES) {
        this.logger.warn(
          `Skipping oversized image (${Math.round(approxBytes / 1024)}KB > ${Math.round(WhatsAppService.MAX_IMAGE_BYTES / 1024)}KB cap)`,
        );
        return null;
      }
      return { mimeType: media.mimetype, data: media.data };
    } catch (error) {
      this.logger.warn(
        `Failed to download image media: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async sendMessage(
    chatName: string,
    text: string,
    media?: WhatsAppMedia,
  ): Promise<string> {
    return this.withSessionRecovery(`sending to "${chatName}"`, () =>
      this.deliverMessage(chatName, text, media),
    );
  }

  private async deliverMessage(
    chatName: string,
    text: string,
    media?: WhatsAppMedia,
  ): Promise<string> {
    const targetChat = await this.findChatByName(chatName);

    try {
      let sent: Message;
      if (media) {
        const messageMedia = new MessageMedia(
          media.mimetype,
          media.data,
          media.filename,
        );
        sent = await targetChat.sendMessage(messageMedia, { caption: text });
      } else {
        sent = await targetChat.sendMessage(text);
      }

      // Mark the chat unread on the user's other devices so an approval /
      // reminder card actually shows up as a notification on their phone.
      // Best-effort: a markUnread failure never fails the send.
      try {
        await (targetChat as Chat & { markUnread?: () => Promise<void> }).markUnread?.();
      } catch (markErr) {
        this.logger.debug(
          `markUnread failed on chat "${chatName}" (continuing): ${(markErr as Error).message}`,
        );
      }

      if (!sent?.id) {
        // whatsapp-web.js returns undefined when it cannot find the message it
        // just sent. The message itself has already gone out, so this is a
        // lookup failure, not a delivery failure — say so plainly instead of
        // failing with "Cannot read properties of undefined (reading 'id')".
        throw new Error(
          `WhatsApp accepted the message for "${chatName}" but whatsapp-web.js ` +
            'could not read it back (MsgKey lookup failed). The approval ' +
            'reaction cannot be tracked for it.',
        );
      }

      const sentId =
        sent.id._serialized ??
        (typeof sent.id === 'string' ? sent.id : sent.id.toString?.());
      if (!sentId || sentId === UNUSABLE_APPROVAL_MESSAGE_ID) {
        throw new Error(
          `WhatsApp accepted the message for "${chatName}" but returned an ` +
            'unreadable message id, so the approval reaction cannot be tracked.',
        );
      }

      return sentId;
    } catch (error) {
      this.appErrorEmitter.emit({
        source: 'whatsapp',
        code: AppErrorCodes.WHATSAPP_SEND_FAILED,
        message: `WhatsApp message could not be sent. ${error.message}`,
      });
      throw error;
    }
  }

  async reactToMessage(messageId: string, emoji: string): Promise<void> {
    if (!this.connected || !this.client) {
      throw new Error('WhatsApp client is not connected.');
    }
    const msg = await this.client.getMessageById(messageId);
    if (!msg) {
      throw new Error(`Message ${messageId} not found for reaction`);
    }
    await msg.react(emoji);
    this.logger.log(`Reacted "${emoji}" to message ${messageId}`);
  }

  /**
   * Delete a message for everyone. Returns true when the message was found and
   * the delete call completed, false when the message was not in the store
   * (already gone). Real delete failures are thrown so callers can react —
   * this method must not silently swallow them.
   */
  /**
   * Ids of every message in a channel whose body contains `needle`, including
   * the app's own outgoing messages.
   *
   * `getChannelMessages` deliberately drops outgoing messages and does not
   * expose ids, so it cannot be used to clean up after ourselves. The smoke
   * test needs exactly that: find the artifacts it posted — its source message
   * and the approval card the pipeline generated from it — and delete them, so
   * a run leaves no residue in the channel even when the DB rows that tracked
   * them are already gone.
   *
   * `needle` is matched literally. Pass something unambiguous
   * (`SMOKE_TEST_MARKER`), never user-supplied text.
   */
  async findMessageIdsContaining(
    channelName: string,
    needle: string,
    limit = 200,
  ): Promise<string[]> {
    if (!needle) return [];
    return this.withSessionRecovery(
      `scanning "${channelName}" for cleanup`,
      async () => {
        const chat = await this.findChatByName(channelName);
        const chatId = this.serializeWid((chat as any).id);
        if (!chatId) return [];

        const messages = await this.fetchMessagesDirectly(chatId, limit, {
          includeOwnMessages: true,
        });
        return messages
          .filter((m) => m.body?.includes(needle))
          // A message deleted for everyone keeps its body in the in-page
          // store, so without this the caller re-finds and re-deletes
          // everything it has already removed — once more on every run.
          .filter((m) => !m.isRevoked)
          .map((m) => m.id)
          .filter((id): id is string => !!id);
      },
    );
  }

  /**
   * Delete a message. Tries delete-for-everyone, then delete-for-me.
   *
   * The return value means "the delete calls went through", not "the message
   * is gone": `msg.delete(true)` resolves even when WhatsApp Web does not
   * carry the revoke out, and `getMessageById` misses messages that plainly
   * exist (the same MsgKey lookup weakness documented in
   * docs/WHATSAPP-RESILIENCE.md). The only trustworthy check is re-reading the
   * chat store — see `findMessageIdsContaining`, which callers that must be
   * sure use to verify.
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.connected || !this.client) {
      throw new Error('WhatsApp client is not connected.');
    }
    const msg = await this.client.getMessageById(messageId);
    if (!msg) {
      this.logger.warn(`Message ${messageId} not found for deletion`);
      return false;
    }

    try {
      await msg.delete(true);
      this.logger.log(`Delete-for-everyone sent for ${messageId}`);
      return true;
    } catch (error) {
      // Past the revoke window, or the internals moved again. Removing it from
      // this account's own chat is still better than leaving it visible.
      this.logger.warn(
        `Delete-for-everyone failed on ${messageId} (${(error as Error).message}); ` +
          'falling back to delete-for-me',
      );
      try {
        await msg.delete(false);
        this.logger.log(`Deleted message ${messageId} for this account`);
        return true;
      } catch (fallbackError) {
        this.logger.warn(
          `Delete-for-me also failed on ${messageId}: ${(fallbackError as Error).message}`,
        );
        return false;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.initPromise = null;
    if (this.client) {
      await this.destroyClient(this.client);
      this.connected = false;
      this.setStatus('disconnected');
      this.client = null;
      this.logger.log('WhatsApp client disconnected');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }
}
