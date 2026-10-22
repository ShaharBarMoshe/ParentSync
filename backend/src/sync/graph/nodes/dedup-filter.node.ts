import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MessageEntity } from '../../../messages/entities/message.entity';
import { MessageDeduplicationService } from '../../services/message-deduplication.service';
import type {
  EventSyncState,
  EventSyncUpdate,
  GroupMeta,
} from '../event-sync.state';

/**
 * Semantic pre-filter: a group whose content matches an already-parsed message
 * skips extraction entirely. Forwarded school messages are the common case,
 * and each one avoided is a full extraction call not made.
 *
 * Fail-open by construction — `findDuplicateOf` returning no match sends the
 * group down the fresh path, which is the safe direction.
 */
@Injectable()
export class DedupFilterNode {
  private readonly logger = new Logger(DedupFilterNode.name);

  constructor(
    private readonly dedupService: MessageDeduplicationService,
    private readonly dataSource: DataSource,
  ) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    const groups = state.groups;
    const freshIndices: number[] = [];
    const duplicateIndices: number[] = [];
    let similaritySum = 0;

    for (let i = 0; i < groups.length; i++) {
      const meta = groups[i];
      const dedup = await this.dedupService.findDuplicateOf(meta.mergedContent);
      meta.dedup = dedup;
      if (dedup.match) {
        duplicateIndices.push(i);
        similaritySum += dedup.match.similarity;
      } else {
        freshIndices.push(i);
      }
    }

    let parsedFromDuplicates = 0;
    if (duplicateIndices.length > 0) {
      const avg = similaritySum / duplicateIndices.length;
      this.logger.log(
        `Dedup pass: ${duplicateIndices.length}/${groups.length} groups skipped (avgSim=${avg.toFixed(3)})`,
      );
      await this.markDuplicatesAsParsed(duplicateIndices.map((i) => groups[i]));
      parsedFromDuplicates = duplicateIndices.reduce(
        (sum, i) => sum + groups[i].group.length,
        0,
      );
    }

    return {
      groups,
      freshIndices,
      duplicateIndices,
      counters: { messagesParsed: parsedFromDuplicates },
    };
  }

  /**
   * Mark every duplicate group parsed, stamping each message with the matched
   * embedding and content hash so a third forward matches via the cheap hash
   * path instead of paying for an embedding.
   *
   * One transaction, opened and committed inside this node. On rollback the
   * messages stay unparsed and the next sync retries them, which is better
   * than dropping them silently.
   */
  private async markDuplicatesAsParsed(
    duplicateGroups: GroupMeta[],
  ): Promise<void> {
    if (duplicateGroups.length === 0) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      for (const dg of duplicateGroups) {
        const embedding = dg.dedup?.embedding ?? null;
        const contentHash = dg.dedup?.contentHash ?? null;
        for (const msg of dg.group) {
          await queryRunner.manager.update(MessageEntity, msg.id, {
            parsed: true,
            embedding,
            contentHash,
          });
          this.logger.debug(
            `Skipped duplicate group channel=${msg.channel} msgId=${msg.id} ` +
              `similarity=${(dg.dedup?.match?.similarity ?? 0).toFixed(3)} ` +
              `matchType=${dg.dedup?.match?.exact ? 'hash' : 'embedding'}`,
          );
        }
      }
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.warn(
        `Dedup mark-as-parsed transaction rolled back, will retry next sync: ${(err as Error).message}`,
      );
    } finally {
      await queryRunner.release();
    }
  }
}
