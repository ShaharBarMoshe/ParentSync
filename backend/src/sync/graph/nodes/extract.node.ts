import { Injectable, Logger } from '@nestjs/common';
import { MessageParserService } from '../../../llm/services/message-parser.service';
import type { ParsedEvent } from '../../../llm/dto/parsed-event.dto';
import { isQuotaExhaustedError } from '../../../llm/errors/llm-quota-exhausted.error';
import { ApprovalService } from '../../services/approval.service';
import type { EventSyncState, EventSyncUpdate } from '../event-sync.state';

/**
 * Extraction for every fresh group.
 *
 * A depleted account aborts the pass here. The groups stay unparsed so the
 * next sync retries them unchanged — marking them parsed would report success
 * while permanently dropping real school events, which is the worst failure
 * this pipeline has.
 */
@Injectable()
export class ExtractNode {
  private readonly logger = new Logger(ExtractNode.name);

  constructor(
    private readonly messageParserService: MessageParserService,
    private readonly approvalService: ApprovalService,
  ) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    const freshGroups = state.freshIndices.map((i) => state.groups[i]);
    let parsed = new Map<string, ParsedEvent[]>();
    let quotaExhausted = false;

    if (freshGroups.length > 0) {
      const requests = freshGroups.map((meta, i) => ({
        id: String(i),
        content: meta.mergedContent,
        images: meta.mergedImages.length > 0 ? meta.mergedImages : undefined,
      }));
      try {
        parsed = await this.messageParserService.parseMessageBatch(
          requests,
          new Date().toISOString().split('T')[0],
          freshGroups.map((meta) => meta.messageDate),
        );
      } catch (error) {
        if (!isQuotaExhaustedError(error)) throw error;
        quotaExhausted = true;
        this.logger.error(
          `LLM quota exhausted — skipping the parse pass, ` +
            `${freshGroups.length} group(s) left unparsed for the next sync: ` +
            `${(error as Error).message}`,
        );
      }
    }

    return {
      parsed,
      quotaExhausted,
      approvalEnabled: await this.approvalService.isApprovalEnabled(),
    };
  }
}
