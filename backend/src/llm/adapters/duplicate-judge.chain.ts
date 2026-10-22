import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { IdenticalSchema } from '../schemas/extraction.schema';
import type { IDuplicateJudge, EventSummary } from '../ports/ai-ports';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';

/**
 * The `IDuplicateJudge` adapter — layer 3 of duplicate suppression.
 *
 * Catches the case the cheaper layers cannot: two messages describing one
 * gathering under different titles at the same date and time
 * ("יום הולדת בבילון" vs "מפגש בבילון"). Layers 1 and 2 (semantic pre-filter,
 * deterministic single-gathering collapse) both key on text similarity and
 * miss it.
 *
 * The old version asked for the literal word "yes" and then stripped
 * non-letters before comparing — a boolean field makes that unnecessary.
 *
 * Returns `false` on any failure, and that direction is deliberate: a wrong
 * `false` at worst asks the user to dismiss a duplicate approval card, while a
 * wrong `true` drops a real event with no trace of it having existed.
 */
@Injectable()
export class DuplicateJudgeChain implements IDuplicateJudge {
  private readonly logger = new Logger(DuplicateJudgeChain.name);

  constructor(
    private readonly chatFactory: GeminiChatFactory,
    private readonly runner: ChainRunner,
  ) {}

  async areIdentical(a: EventSummary, b: EventSummary): Promise<boolean> {
    const chain = this.chatFactory
      .create({ maxTokens: 64 })
      .withStructuredOutput(IdenticalSchema, { name: 'duplicate_verdict' });

    const messages = [
      new SystemMessage(
        'You compare calendar events and decide whether they describe the ' +
          'same real-world gathering. Be precise.',
      ),
      new HumanMessage(
        'Do these two calendar events refer to the SAME real-world ' +
          'gathering? They share a date and time slot but may have been ' +
          'described from different angles in different messages.\n\n' +
          `Event A:\n${format(a)}\n\nEvent B:\n${format(b)}`,
      ),
    ];

    try {
      const verdict = await this.runner.run(chain, messages, {
        model: this.chatFactory.defaultModel,
        runName: 'judge-duplicate',
      });
      return verdict.identical === true;
    } catch (error) {
      this.logger.warn(
        `Duplicate judge failed (treating as different): ${(error as Error).message}`,
      );
      return false;
    }
  }
}

function format(e: EventSummary): string {
  return [
    `Title: ${e.title}`,
    `Date: ${e.date}`,
    `Time: ${e.time ?? 'all-day'}`,
    `Location: ${e.location ?? 'none'}`,
    `Description: ${e.description ?? 'none'}`,
  ].join('\n');
}
