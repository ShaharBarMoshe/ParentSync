export interface WhatsAppMessage {
  content: string;
  timestamp: Date;
  sender: string;
  channel: string;
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
  disconnect(): Promise<void>;
}
