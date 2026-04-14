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

  async getChannelMessages(
    channelName: string,
    limit = 50,
  ): Promise<WhatsAppMessage[]> {
    const targetChat = await this.findChatByName(channelName);

    let messages: Message[];
    try {
      messages = await targetChat.fetchMessages({ limit });
    } catch (error) {
      const isStaleSession =
        error.message?.includes('waitForChatLoading') ||
        error.message?.includes('Cannot read properties of undefined');

      if (!isStaleSession) {
        this.logger.warn(
          `Failed to fetch messages from "${channelName}" (channel may be empty): ${error.message}`,
        );
        return [];
      }

      // Try reconnecting once per sync cycle if the session looks stale
      if (!this.reconnectedThisCycle) {
        this.reconnectedThisCycle = true;
        this.logger.warn(
          `WhatsApp session appears stale for "${channelName}" — reinitializing client (once per sync)`,
        );
        this.connected = false;
        try {
          await this.initialize();
          // Wait for WhatsApp Web to fully load chat data after reconnect;
          // the 'ready' event fires before internal chat loading completes.
          await new Promise((resolve) => setTimeout(resolve, 15_000));
        } catch (reconnectError) {
          this.logger.warn(
            `Failed to reconnect WhatsApp: ${reconnectError.message}`,
          );
          return [];
        }
      }

      // Retry with a fresh chat reference (whether we just reconnected or
      // a previous channel already triggered the reconnect this cycle)
      try {
        const retryChat = await this.findChatByName(channelName);
        messages = await retryChat.fetchMessages({ limit });
      } catch (retryError) {
        this.logger.warn(
          `Failed to fetch messages from "${channelName}" after reconnect: ${retryError.message}`,
        );
        return [];
      }
    }

    return messages.map((msg) => ({
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
