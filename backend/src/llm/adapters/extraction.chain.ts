import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, ContentBlock } from '@langchain/core/messages';
import {
  BatchExtractionSchema,
  SingleExtractionSchema,
} from '../schemas/extraction.schema';
import { normalizeEvents } from '../domain/event-normalizer';
import type {
  IEventExtractor,
  ExtractionRequest,
  ExtractionResult,
  InlineImage,
} from '../ports/ai-ports';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';

/**
 * Free-tier Gemini models degrade badly past this many messages in one call —
 * later groups start coming back empty. Larger batches are chunked.
 */
const MAX_BATCH_SIZE = 8;

/**
 * The `IEventExtractor` adapter: LangChain structured output against Gemini.
 *
 * What this class no longer contains, versus the code it replaces: markdown
 * fence stripping, brace-matching, `coerceToEventArray`, the `hasAnyKey`
 * heuristic, and the "batch parse failed → reparse every group individually"
 * fallback. `withStructuredOutput` makes the provider responsible for the
 * shape, so a malformed response is a retry (handled by `ChainRunner`) rather
 * than a second doomed pass over the same content.
 *
 * What it does still contain is the batching policy, because that is a real
 * decision about cost and reliability rather than a parsing workaround:
 * text-only groups ride one call, image groups go alone (a model gets one
 * image bundle per request and cannot tell which message owns which image).
 */
@Injectable()
export class ExtractionChain implements IEventExtractor {
  private readonly logger = new Logger(ExtractionChain.name);

  constructor(
    private readonly chatFactory: GeminiChatFactory,
    private readonly runner: ChainRunner,
    private readonly prompts: PromptRegistry,
  ) {}

  async extract(requests: ExtractionRequest[]): Promise<ExtractionResult[]> {
    if (requests.length === 0) return [];

    const { prompt } = await this.prompts.systemPrompt();
    const results = new Map<string, ExtractionResult>();

    const withImages = requests.filter((r) => r.images?.length);
    const textOnly = requests.filter((r) => !r.images?.length);

    for (const request of withImages) {
      results.set(request.id, await this.extractOne(request, prompt));
    }

    for (let i = 0; i < textOnly.length; i += MAX_BATCH_SIZE) {
      const chunk = textOnly.slice(i, i + MAX_BATCH_SIZE);
      // One message is not a batch — the single-message prompt is shorter and
      // the schema simpler, so don't pay for the batch framing.
      const chunkResults =
        chunk.length === 1
          ? [await this.extractOne(chunk[0], prompt)]
          : await this.extractBatch(chunk, prompt);
      for (const result of chunkResults) results.set(result.id, result);
    }

    // Exactly one result per request, in request order. A group the provider
    // silently omitted comes back empty rather than missing, so the caller can
    // still mark its messages parsed instead of retrying them forever.
    return requests.map(
      (request) => results.get(request.id) ?? { id: request.id, events: [] },
    );
  }

  private async extractOne(
    request: ExtractionRequest,
    systemPrompt: string,
  ): Promise<ExtractionResult> {
    const model = this.chatFactory.defaultModel;
    const chain = this.chatFactory
      .create({ maxTokens: 2048 })
      .withStructuredOutput(SingleExtractionSchema, { name: 'extract_events' });

    const imageNote = request.images?.length
      ? `\n\nThe message also has ${request.images.length} attached image(s). ` +
        'Extract any events visible in them — flyers, schedules, screenshots.'
      : '';

    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      this.userMessage(
        `Current date: ${request.dateContext}\n\n` +
          `Message to parse:\n${request.content}${imageNote}`,
        request.images,
      ),
    ];

    const output = await this.runner.run(chain, messages, {
      model,
      runName: 'extract-events',
    });

    const events = normalizeEvents(output.events ?? [], this.logger);
    this.logger.log(
      `Extracted ${output.events?.length ?? 0} raw → ${events.length} valid events (group ${request.id})`,
    );
    return { id: request.id, events };
  }

  private async extractBatch(
    requests: ExtractionRequest[],
    systemPrompt: string,
  ): Promise<ExtractionResult[]> {
    const model = this.chatFactory.defaultModel;
    // More groups means more output; the ceiling is the model's own.
    const maxTokens = Math.min(2048 + requests.length * 512, 8192);
    const chain = this.chatFactory
      .create({ maxTokens })
      .withStructuredOutput(BatchExtractionSchema, {
        name: 'extract_events_batch',
      });

    const body = requests
      .map(
        (r) =>
          `===MESSAGE id="${r.id}"===\n` +
          `Current date for this message: ${r.dateContext}\n${r.content}`,
      )
      .join('\n\n');

    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(
        `Parse the following ${requests.length} messages. Each carries its own ` +
          '"Current date" — resolve relative dates like "tomorrow" against ' +
          "that message's date, not against any other.\n" +
          'Return one result per message, echoing its id exactly.\n\n' +
          body,
      ),
    ];

    this.logger.log(`Batch extracting ${requests.length} message groups`);
    const output = await this.runner.run(chain, messages, {
      model,
      runName: 'extract-events-batch',
    });

    const byId = new Map(
      (output.results ?? []).map((r) => [r.id, r.events ?? []]),
    );

    // An id we never sent means the model invented one; log it rather than
    // letting it vanish, because it usually means ids were mangled and every
    // group is about to come back empty.
    const requested = new Set(requests.map((r) => r.id));
    for (const id of byId.keys()) {
      if (!requested.has(id)) {
        this.logger.warn(`Batch result carried unknown group id "${id}"`);
      }
    }

    return requests.map((request) => {
      const raw = byId.get(request.id);
      if (raw === undefined) {
        this.logger.warn(`Batch result missing group id "${request.id}"`);
      }
      const events = normalizeEvents(raw ?? [], this.logger);
      this.logger.log(
        `Batch group ${request.id}: ${raw?.length ?? 0} raw → ${events.length} valid events`,
      );
      return { id: request.id, events };
    });
  }

  /**
   * LangChain v1 carries base64 media natively, so the Gemini adapter builds
   * the `inlineData` part itself — no `data:` URL round-trip.
   */
  private userMessage(text: string, images?: InlineImage[]): HumanMessage {
    if (!images?.length) return new HumanMessage(text);
    const parts: ContentBlock[] = [{ type: 'text', text }];
    for (const image of images) {
      parts.push({ type: 'image', mimeType: image.mimeType, data: image.data });
    }
    return new HumanMessage({ content: parts });
  }
}
