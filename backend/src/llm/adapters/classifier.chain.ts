import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { VerdictSchema } from '../schemas/extraction.schema';
import type {
  IRelevanceClassifier,
  ClassifierVerdict,
} from '../ports/ai-ports';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';

/**
 * The `IRelevanceClassifier` adapter — stage 1 of the pipeline.
 *
 * The old version asked for a `YES — reason` / `NO — reason` line and then
 * pattern-matched it, with three separate fail-open branches for an empty
 * response, an unparseable one, and a first line polluted by commentary.
 * A boolean field in a schema removes all three: the provider cannot return
 * "YES, but let me explain" into a `z.boolean()`.
 *
 * The fail-open contract is unchanged and still matters more than anything
 * else here: a gate that errs towards "not an event" silently drops real
 * school events, which is the one failure nobody would notice.
 */
@Injectable()
export class ClassifierChain implements IRelevanceClassifier {
  private readonly logger = new Logger(ClassifierChain.name);

  constructor(
    private readonly chatFactory: GeminiChatFactory,
    private readonly runner: ChainRunner,
    private readonly prompts: PromptRegistry,
  ) {}

  async classify(
    content: string,
    dateContext?: string,
  ): Promise<ClassifierVerdict> {
    const { prompt } = await this.prompts.classifierPrompt();
    const chain = this.chatFactory
      .create({ maxTokens: 256 })
      .withStructuredOutput(VerdictSchema, { name: 'relevance_verdict' });

    const prefix = dateContext ? `Current date: ${dateContext}\n\n` : '';
    const messages = [
      new SystemMessage(prompt),
      new HumanMessage(`${prefix}${content}`),
    ];

    try {
      const verdict = await this.runner.run(chain, messages, {
        model: this.chatFactory.defaultModel,
        runName: 'classify-relevance',
      });
      return {
        isEvent: verdict.isEvent,
        reason: (verdict.reason || '').trim().slice(0, 80) || '(no reason)',
      };
    } catch (error) {
      // Fail open — see the class comment. Includes quota exhaustion: a
      // depleted account must not be recorded as "this message is not an
      // event", because the extractor's own quota handling is what decides
      // whether to leave the message unparsed for the next sync.
      this.logger.warn(
        `Classifier fail-open: ${(error as Error).message}`,
      );
      return { isEvent: true, reason: 'classifier-fail-open' };
    }
  }
}
