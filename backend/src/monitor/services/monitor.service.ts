import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageEntity } from '../../messages/entities/message.entity';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { SyncLogEntity } from '../../sync/entities/sync-log.entity';
import { QueryMonitorDto } from '../dto/query-monitor.dto';

export interface ChartDataset {
  label: string;
  data: number[];
}

export interface ChartResponse {
  labels: string[];
  datasets: ChartDataset[];
}

export interface SyncHistoryEntry {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  messageCount: number;
  eventsCreated: number;
  durationMs: number | null;
  channelDetails: unknown;
}

export interface SummaryResponse {
  totalMessages: number;
  totalEvents: number;
  avgMessagesPerSync: number;
  avgSyncDurationMs: number;
  syncSuccessRate: number;
  totalSyncs: number;
  mostActiveChannel: string | null;
  lastSync: { timestamp: string; status: string } | null;
  previousPeriod: {
    totalMessages: number;
    totalEvents: number;
  };
}

@Injectable()
export class MonitorService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(CalendarEventEntity)
    private readonly eventRepo: Repository<CalendarEventEntity>,
    @InjectRepository(SyncLogEntity)
    private readonly syncLogRepo: Repository<SyncLogEntity>,
  ) {}

  private getDateRange(query: QueryMonitorDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from, to };
  }

  private formatDateForGroup(
    date: Date,
    groupBy: 'day' | 'week' | 'month',
  ): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    switch (groupBy) {
      case 'month':
        return `${year}-${month}`;
      case 'week': {
        // Get Monday of the week
        const d = new Date(date);
        const dayOfWeek = d.getDay();
        const diff = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        d.setDate(diff);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      case 'day':
      default:
        return `${year}-${month}-${day}`;
    }
  }

  private generateLabels(
    from: Date,
    to: Date,
    groupBy: 'day' | 'week' | 'month',
  ): string[] {
    const labels: string[] = [];
    const current = new Date(from);

    while (current <= to) {
      const label = this.formatDateForGroup(current, groupBy);
      if (!labels.includes(label)) {
        labels.push(label);
      }

      switch (groupBy) {
        case 'month':
          current.setMonth(current.getMonth() + 1);
          break;
        case 'week':
          current.setDate(current.getDate() + 7);
          break;
        case 'day':
        default:
          current.setDate(current.getDate() + 1);
          break;
      }
    }

    return labels;
  }

  async getMessagesOverTime(query: QueryMonitorDto): Promise<ChartResponse> {
    const { from, to } = this.getDateRange(query);
    const groupBy = query.groupBy || 'day';

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.timestamp >= :from AND m.timestamp <= :to', { from, to });

    if (query.childId) {
      qb.andWhere('m.childId = :childId', { childId: query.childId });
    }

    const messages = await qb.getMany();

    const labels = this.generateLabels(from, to, groupBy);
    const whatsappData = new Map<string, number>();
    const emailData = new Map<string, number>();

    for (const label of labels) {
      whatsappData.set(label, 0);
      emailData.set(label, 0);
    }

    for (const msg of messages) {
      const label = this.formatDateForGroup(new Date(msg.timestamp), groupBy);
      if (msg.source === 'whatsapp') {
        whatsappData.set(label, (whatsappData.get(label) || 0) + 1);
      } else {
        emailData.set(label, (emailData.get(label) || 0) + 1);
      }
    }

    return {
      labels,
      datasets: [
        { label: 'WhatsApp', data: labels.map((l) => whatsappData.get(l) || 0) },
        { label: 'Email', data: labels.map((l) => emailData.get(l) || 0) },
      ],
    };
  }

  async getEventsPerChannel(query: QueryMonitorDto): Promise<ChartResponse> {
    const { from, to } = this.getDateRange(query);

    const qb = this.eventRepo
      .createQueryBuilder('e')
      .where('e.createdAt >= :from AND e.createdAt <= :to', { from, to });

    if (query.childId) {
      qb.andWhere('e.childId = :childId', { childId: query.childId });
    }

    const events = await qb.getMany();

    const channelCounts = new Map<string, { count: number; source: string }>();

    for (const evt of events) {
      // Get channel from the source message
      const channel = evt.sourceId ? await this.getChannelForEvent(evt) : 'Unknown';
      const existing = channelCounts.get(channel);
      if (existing) {
        existing.count++;
      } else {
        channelCounts.set(channel, { count: 1, source: evt.source || 'unknown' });
      }
    }

    // Sort by count descending
    const sorted = [...channelCounts.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );

    return {
      labels: sorted.map(([channel]) => channel),
      datasets: [
        {
          label: 'Events',
          data: sorted.map(([, val]) => val.count),
        },
      ],
    };
  }

  private async getChannelForEvent(
    evt: CalendarEventEntity,
  ): Promise<string> {
    if (!evt.sourceId) return 'Unknown';
    const msg = await this.messageRepo.findOne({
      where: { id: evt.sourceId },
    });
    return msg?.channel || 'Unknown';
  }

  async getSyncHistory(
    query: QueryMonitorDto,
  ): Promise<SyncHistoryEntry[]> {
    const { from, to } = this.getDateRange(query);

    const logs = await this.syncLogRepo
      .createQueryBuilder('s')
      .where('s.timestamp >= :from AND s.timestamp <= :to', { from, to })
      .orderBy('s.timestamp', 'ASC')
      .getMany();

    return logs.map((log) => {
      let durationMs: number | null = null;
      if (log.startedAt && log.endedAt) {
        durationMs =
          new Date(log.endedAt).getTime() -
          new Date(log.startedAt).getTime();
      }

      return {
        id: log.id,
        startedAt: log.startedAt ? log.startedAt.toISOString() : null,
        endedAt: log.endedAt ? log.endedAt.toISOString() : null,
        status: log.status,
        messageCount: log.messageCount,
        eventsCreated: log.eventsCreated,
        durationMs,
        channelDetails: log.channelDetails,
      };
    });
  }

  async getSummary(query: QueryMonitorDto): Promise<SummaryResponse> {
    const { from, to } = this.getDateRange(query);
    const periodMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - periodMs);
    const prevTo = from;

    // Current period messages
    const msgQb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.timestamp >= :from AND m.timestamp <= :to', { from, to });
    if (query.childId) {
      msgQb.andWhere('m.childId = :childId', { childId: query.childId });
    }
    const totalMessages = await msgQb.getCount();

    // Current period events
    const evtQb = this.eventRepo
      .createQueryBuilder('e')
      .where('e.createdAt >= :from AND e.createdAt <= :to', { from, to });
    if (query.childId) {
      evtQb.andWhere('e.childId = :childId', { childId: query.childId });
    }
    const totalEvents = await evtQb.getCount();

    // Sync logs for current period
    const syncLogs = await this.syncLogRepo
      .createQueryBuilder('s')
      .where('s.timestamp >= :from AND s.timestamp <= :to', { from, to })
      .getMany();

    const totalSyncs = syncLogs.length;
    const successSyncs = syncLogs.filter(
      (s) => s.status === 'success',
    ).length;
    const syncSuccessRate = totalSyncs > 0 ? successSyncs / totalSyncs : 0;

    const avgMessagesPerSync =
      totalSyncs > 0
        ? syncLogs.reduce((sum, s) => sum + s.messageCount, 0) / totalSyncs
        : 0;

    const durations = syncLogs
      .filter((s) => s.startedAt && s.endedAt)
      .map(
        (s) =>
          new Date(s.endedAt!).getTime() - new Date(s.startedAt!).getTime(),
      );
    const avgSyncDurationMs =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;

    // Most active channel
    const channelMessages = await this.messageRepo
      .createQueryBuilder('m')
      .select('m.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where('m.timestamp >= :from AND m.timestamp <= :to', { from, to })
      .groupBy('m.channel')
      .orderBy('count', 'DESC')
      .limit(1)
      .getRawOne();

    // Last sync
    const lastSync = syncLogs.length > 0
      ? syncLogs.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )[0]
      : null;

    // Previous period
    const prevMsgQb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.timestamp >= :from AND m.timestamp <= :to', {
        from: prevFrom,
        to: prevTo,
      });
    if (query.childId) {
      prevMsgQb.andWhere('m.childId = :childId', { childId: query.childId });
    }
    const prevMessages = await prevMsgQb.getCount();

    const prevEvtQb = this.eventRepo
      .createQueryBuilder('e')
      .where('e.createdAt >= :from AND e.createdAt <= :to', {
        from: prevFrom,
        to: prevTo,
      });
    if (query.childId) {
      prevEvtQb.andWhere('e.childId = :childId', { childId: query.childId });
    }
    const prevEvents = await prevEvtQb.getCount();

    return {
      totalMessages,
      totalEvents,
      avgMessagesPerSync: Math.round(avgMessagesPerSync * 10) / 10,
      avgSyncDurationMs: Math.round(avgSyncDurationMs),
      syncSuccessRate: Math.round(syncSuccessRate * 100),
      totalSyncs,
      mostActiveChannel: channelMessages?.channel || null,
      lastSync: lastSync
        ? { timestamp: lastSync.timestamp.toISOString(), status: lastSync.status }
        : null,
      previousPeriod: {
        totalMessages: prevMessages,
        totalEvents: prevEvents,
      },
    };
  }

  async getChannelsActivity(query: QueryMonitorDto): Promise<{
    channels: string[];
    dates: string[];
    data: number[][];
  }> {
    const { from, to } = this.getDateRange(query);
    const groupBy = query.groupBy || 'day';

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.timestamp >= :from AND m.timestamp <= :to', { from, to });

    if (query.childId) {
      qb.andWhere('m.childId = :childId', { childId: query.childId });
    }

    const messages = await qb.getMany();

    const dates = this.generateLabels(from, to, groupBy);
    const channelSet = new Set<string>();

    for (const msg of messages) {
      channelSet.add(msg.channel);
    }

    const channels = [...channelSet].sort();

    // Build matrix: channels x dates
    const matrix = new Map<string, Map<string, number>>();
    for (const channel of channels) {
      matrix.set(channel, new Map());
      for (const date of dates) {
        matrix.get(channel)!.set(date, 0);
      }
    }

    for (const msg of messages) {
      const date = this.formatDateForGroup(new Date(msg.timestamp), groupBy);
      const channelMap = matrix.get(msg.channel);
      if (channelMap) {
        channelMap.set(date, (channelMap.get(date) || 0) + 1);
      }
    }

    const data = channels.map((channel) =>
      dates.map((date) => matrix.get(channel)!.get(date) || 0),
    );

    return { channels, dates, data };
  }
}
