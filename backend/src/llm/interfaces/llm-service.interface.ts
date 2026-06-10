export interface LlmInlineImage {
  mimeType: string;
  data: string; // base64-encoded image bytes (no data: prefix)
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Optional inline images attached to a `user` message. Adapters translate
   * these into the provider-native multimodal format (Gemini `inlineData`
   * parts, OpenAI-style `image_url` parts). Ignored on system/assistant
   * messages — only `user` messages carry image input.
   */
  images?: LlmInlineImage[];
}

export interface ILLMService {
  callLLM(
    messages: LlmMessage[],
    model?: string,
    temperature?: number,
    maxTokens?: number,
  ): Promise<string>;
}
