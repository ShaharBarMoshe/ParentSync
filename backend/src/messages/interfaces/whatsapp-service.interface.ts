export interface WhatsAppMessageImage {
  mimeType: string;
  data: string; // base64-encoded
}

export interface WhatsAppMessage {
  content: string;
  timestamp: Date;
  sender: string;
  channel: string;
  /**
   * Inline images attached to the message (school flyers, screenshots, etc.).
   * Forwarded to the LLM as multimodal input so we can extract events from
   * pictures that have no accompanying caption.
   */
  images?: WhatsAppMessageImage[];
}

export interface WhatsAppMedia {
  mimetype: string;
  data: string; // base64-encoded
  filename: string;
}

export interface WhatsAppReaction {
  msgId: string;
  reaction: string; // emoji text, empty string = reaction removed
  senderId: string;
  timestamp: number;
}

export type WhatsAppConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'waiting_for_qr'
  | 'authenticated'
  | 'connected';

export interface IWhatsAppService {
  initialize(): Promise<void>;
  isConnected(): boolean;
  getConnectionStatus(): WhatsAppConnectionStatus;
  resetReconnectFlag(): void;
  getChannelMessages(
    channelName: string,
    limit?: number,
  ): Promise<WhatsAppMessage[]>;
  sendMessage(
    chatName: string,
    text: string,
    media?: WhatsAppMedia,
  ): Promise<string>; // returns serialized message ID
  /**
   * Ids of messages in a channel whose body contains `needle`, including the
   * app's own outgoing messages (which `getChannelMessages` drops). Used by
   * the smoke test to find and delete the artifacts it left behind.
   */
  findMessageIdsContaining(
    channelName: string,
    needle: string,
    limit?: number,
  ): Promise<string[]>;
  /** React to a previously-sent message with an emoji (e.g. '👍'). */
  reactToMessage(messageId: string, emoji: string): Promise<void>;
  /**
   * Delete a message for everyone. Resolves true when the message was found and
   * deleted, false when it was not in the store. Throws on a real delete
   * failure (does not swallow). Used by the smoke test cleanup.
   */
  deleteMessage(messageId: string): Promise<boolean>;
  disconnect(): Promise<void>;
}
