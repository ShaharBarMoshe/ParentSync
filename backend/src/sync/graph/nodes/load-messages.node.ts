import { Injectable, Logger, Inject } from '@nestjs/common';
import { MESSAGE_REPOSITORY } from '../../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../../messages/interfaces/message-repository.interface';
import { MessageEntity } from '../../../messages/entities/message.entity';
import { ChildService } from '../../../settings/child.service';
import type { EventSyncUpdate, GroupMeta } from '../event-sync.state';

/** Messages this far apart in one channel are still one conversation. */
const MERGE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Find unparsed messages, cluster them by channel and time proximity, and
 * attach what extraction needs: the child, a date anchor so relative dates
 * resolve as the sender meant them, and any images in the cluster.
 *
 * No AI, no transaction — purely a read and a shape.
 */
@Injectable()
export class LoadMessagesNode {
  private readonly logger = new Logger(LoadMessagesNode.name);

  constructor(
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    private readonly childService: ChildService,
  ) {}

  async run(): Promise<EventSyncUpdate> {
    const unparsed = await this.messageRepository.findUnparsed();
    this.logger.log(`Found ${unparsed.length} unparsed messages`);

    const clusters = this.groupByProximity(unparsed);
    this.logger.log(
      `Grouped ${unparsed.length} messages into ${clusters.length} groups`,
    );

    const groups: GroupMeta[] = [];
    for (const group of clusters) {
      const first = group[0];
      let childName: string | undefined;
      let calendarColorId: string | undefined;

      if (first.childId) {
        try {
          const child = await this.childService.findById(first.childId);
          childName = child.name;
          calendarColorId = child.calendarColor || undefined;
        } catch {
          this.logger.warn(
            `Child with id "${first.childId}" not found for message ${first.id}`,
          );
        }
      }

      // The newest message in the cluster anchors relative dates — a message
      // parsed three days late must still resolve "tomorrow" to the day after
      // it was sent, not the day after the sync ran.
      const latest = group.reduce((max, msg) => {
        const t = new Date(msg.timestamp).getTime();
        return t > max ? t : max;
      }, 0);

      groups.push({
        group,
        childName,
        childId: first.childId,
        calendarColorId,
        mergedContent: this.mergeContent(group),
        // One image bundle per group: group-level extraction cannot reliably
        // attribute an image back to an individual message anyway.
        mergedImages: group.flatMap((m) => m.images ?? []),
        messageDate: new Date(latest).toISOString().split('T')[0],
      });
    }

    return { groups };
  }

  /**
   * Cluster messages from one channel that arrived within the merge window.
   * A burst of five messages about one trip becomes one extraction call
   * instead of five.
   */
  private groupByProximity(messages: MessageEntity[]): MessageEntity[][] {
    const byChannel = new Map<string, MessageEntity[]>();
    for (const msg of messages) {
      const bucket = byChannel.get(msg.channel) ?? [];
      bucket.push(msg);
      byChannel.set(msg.channel, bucket);
    }

    const groups: MessageEntity[][] = [];
    for (const channelMessages of byChannel.values()) {
      channelMessages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      let current: MessageEntity[] = [channelMessages[0]];
      for (let i = 1; i < channelMessages.length; i++) {
        const prev = new Date(channelMessages[i - 1].timestamp).getTime();
        const curr = new Date(channelMessages[i].timestamp).getTime();
        if (curr - prev <= MERGE_WINDOW_MS) {
          current.push(channelMessages[i]);
        } else {
          groups.push(current);
          current = [channelMessages[i]];
        }
      }
      groups.push(current);
    }
    return groups;
  }

  /**
   * Merge a cluster into one string. Each message keeps its timestamp and
   * sender so the model can tell who said what and in which order — a
   * correction ("actually it's at 10, not 9") only reads correctly with them.
   */
  private mergeContent(group: MessageEntity[]): string {
    if (group.length === 1) return group[0].content;

    return group
      .map((msg) => {
        const ts = new Date(msg.timestamp);
        const time = ts.toLocaleTimeString('he-IL', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const date = ts.toLocaleDateString('he-IL');
        return `[${time}, ${date}] ${msg.sender || 'unknown'}: ${msg.content}`;
      })
      .join('\n');
  }
}
