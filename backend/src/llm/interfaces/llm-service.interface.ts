export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ILLMService {
  callLLM(
    messages: LlmMessage[],
    model?: string,
    temperature?: number,
    maxTokens?: number,
  ): Promise<string>;
}
