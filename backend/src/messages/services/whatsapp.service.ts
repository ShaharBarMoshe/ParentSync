import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Chat, Message, MessageMedia, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import {
  IWhatsAppService,
  WhatsAppMessage,
  WhatsAppMedia,
  WhatsAppConnectionStatus,
} from '../interfaces/whatsapp-service.interface';

@Injectable()
export class WhatsAppService
  implements IWhatsAppService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsAppService.name);
  private client: Client | null = null;
  private connected = false;
  private connectionStatus: WhatsAppConnectionStatus = 'disconnected';
  private initPromise: Promise<void> | null = null;

  constructor(private readonly eventEmitter: EventEmitter2) {}

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
      this.eventEmitter.emit('whatsapp.reaction', {
        msgId: reaction.msgId?._serialized || '',
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

    const chats: Chat[] = await this.client.getChats();
    const normalizedTarget = this.normalizeText(chatName);
    const targetChat = chats.find(
      (chat) => this.normalizeText(chat.name) === normalizedTarget,
    );

    if (!targetChat) {
      const chatNames = chats.map((c) => c.name).slice(0, 50);
      this.logger.warn(
        `Channel "${chatName}" not found. Available chats: ${JSON.stringify(chatNames)}`,
      );
      throw new Error(`Channel "${chatName}" not found`);
    }

    return targetChat;
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
   */
  private async fetchMessagesDirectly(
    chatId: string,
    limit: number,
  ): Promise<Array<{ body: string; timestamp: number; author?: string; from: string }>> {
    if (!this.client) {
      throw new Error('WhatsApp client is not connected.');
    }

    const page = (this.client as any).pupPage;
    if (!page) {
      throw new Error('Puppeteer page not available.');
    }

    return page.evaluate(
      async (serializedChatId: string, msgLimit: number) => {
        const win = window as any;
        const chatWid = win.Store.WidFactory.createWid(serializedChatId);
        const chat =
          win.Store.Chat.get(chatWid) ||
          (await win.Store.FindOrCreateChat.findOrCreateLatestChat(chatWid))?.chat;

        if (!chat || !chat.msgs) return [];

        const msgs = chat.msgs
          .getModelsArray()
          .filter((m: any) => !m.isNotification)
          .sort((a: any, b: any) => b.t - a.t)
          .slice(0, msgLimit);

        return msgs.map((m: any) => ({
          body: m.body || '',
          timestamp: m.t,
          author: m.author || undefined,
          from: m.id?.remote?._serialized || m.id?.remote || '',
        }));
      },
      chatId,
      limit,
    );
  }

  async getChannelMessages(
    channelName: string,
    limit = 50,
  ): Promise<WhatsAppMessage[]> {
    const targetChat = await this.findChatByName(channelName);
    const chatId = (targetChat as any).id?._serialized;

    let rawMessages: Array<{ body: string; timestamp: number; author?: string; from: string }>;
    try {
      rawMessages = await this.fetchMessagesDirectly(chatId, limit);
    } catch (error) {
      this.logger.warn(
        `Direct message fetch failed for "${channelName}", falling back to fetchMessages: ${error.message}`,
      );
      // Fallback to original fetchMessages
      try {
        const messages = await targetChat.fetchMessages({ limit });
        return messages.map((msg) => ({
          content: msg.body,
          timestamp: new Date(msg.timestamp * 1000),
          sender: msg.author || msg.from,
          channel: channelName,
        }));
      } catch (fallbackError) {
        this.logger.warn(
          `Failed to fetch messages from "${channelName}": ${fallbackError.message}`,
        );
        return [];
      }
    }

    return rawMessages.map((msg) => ({
      content: msg.body,
      timestamp: new Date(msg.timestamp * 1000),
      sender: msg.author || msg.from,
      channel: channelName,
    }));
  }

  async sendMessage(
    chatName: string,
    text: string,
    media?: WhatsAppMedia,
  ): Promise<string> {
    const targetChat = await this.findChatByName(chatName);

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

    return sent.id._serialized;
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
